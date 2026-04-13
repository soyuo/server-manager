import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response, NextFunction } from 'express';
import expressWs from 'express-ws';
import jwt from 'jsonwebtoken';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const app = express();
const wsInstance = expressWs(app);
const wss = wsInstance.getWss();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'server-secret-key-2026';
const PASSWORD = process.env.MANAGER_PASSWORD || 'password';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

interface AuthRequest extends Request {
  user?: { authenticated: boolean };
}

function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: '인증 토큰이 없습니다.' });
    return;
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { authenticated: boolean };
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: '유효하지 않은 토큰입니다.' });
  }
}

async function broadcastPM2() {
  try {
    const { stdout } = await pm2Command('jlist');
    const processes = JSON.parse(stdout);

    const payload = JSON.stringify({
      type: 'pm2',
      data: processes
    });

    wss.clients.forEach((client: any) => {
      if (client.readyState === 1) {
        client.send(payload);
      }
    });
  } catch (e) {
    console.error(e);
  }
}

app.ws('/ws', (ws: any, _req: Request) => {
  console.log('WS connected');

  ws.on('close', () => {
    console.log('WS disconnected');
  });
});

app.post('/api/auth', (req: Request, res: Response): void => {
  const { password } = req.body as { password: string };
  if (password === PASSWORD) {
    const token = jwt.sign({ authenticated: true }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, message: '인증 성공' });
  } else {
    res.status(401).json({ error: '비밀번호가 틀렸습니다.' });
  }
});

app.get('/api/auth/verify', authMiddleware, (_req: Request, res: Response): void => {
  res.json({ valid: true });
});

function safePath(inputPath: string): string {
  const resolved = path.resolve(inputPath || '/');
  return resolved;
}

app.get('/api/files/list', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const dirPath = safePath((req.query.path as string) || '/');
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const items = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(dirPath, entry.name);
        let size = 0;
        let modifiedAt = '';
        try {
          const stat = await fs.promises.stat(fullPath);
          size = stat.size;
          modifiedAt = stat.mtime.toISOString();
        } catch {
          // ignore
        }
        return {
          name: entry.name,
          path: fullPath,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
          size,
          modifiedAt,
        };
      })
    );
    // Sort: directories first, then files
    items.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });
    res.json({ path: dirPath, items });
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/files/read', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const filePath = safePath(req.query.path as string);
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > 5 * 1024 * 1024) {
      res.status(400).json({ error: '파일이 너무 큽니다 (5MB 초과).' });
      return;
    }
    const content = await fs.promises.readFile(filePath, 'utf-8');
    res.json({ path: filePath, content });
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/files/write', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { path: filePath, content } = req.body as { path: string; content: string };
  try {
    await fs.promises.writeFile(safePath(filePath), content, 'utf-8');
    res.json({ message: '저장 완료', path: filePath });
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/files/create', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { path: targetPath, type, content } = req.body as {
    path: string;
    type: 'file' | 'directory';
    content?: string;
  };
  const safe = safePath(targetPath);
  try {
    if (type === 'directory') {
      await fs.promises.mkdir(safe, { recursive: true });
    } else {
      await fs.promises.writeFile(safe, content || '', 'utf-8');
    }
    res.json({ message: '생성 완료', path: safe });
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/files/delete', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const filePath = safePath(req.query.path as string);
  try {
    await fs.promises.rm(filePath, { recursive: true, force: true });
    res.json({ message: '삭제 완료', path: filePath });
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/files/rename', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { oldPath, newPath } = req.body as { oldPath: string; newPath: string };
  try {
    await fs.promises.rename(safePath(oldPath), safePath(newPath));
    res.json({ message: '이름 변경 완료' });
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    res.status(400).json({ error: error.message });
  }
});

async function pm2Command(cmd: string): Promise<{ stdout: string; stderr: string }> {
  return execAsync(`pm2 ${cmd} --no-color`);
}

app.get('/api/pm2/list', authMiddleware, async (_req: Request, res: Response): Promise<void> => {
  try {
    const { stdout } = await pm2Command('jlist');
    const processes = JSON.parse(stdout) as Array<{
      pid: number;
      name: string;
      pm_id: number;
      pm2_env: {
        status: string;
        restart_time: number;
        created_at: number;
        pm_uptime: number;
        exec_interpreter: string;
        pm_exec_path: string;
        cwd: string;
        args: string[];
      };
      monit: {
        memory: number;
        cpu: number;
      };
    }>;
    res.json({ processes });
  } catch (err: unknown) {
    const error = err as Error;
    res.status(500).json({ error: error.message, processes: [] });
  }
});

app.post('/api/pm2/restart/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const flush = req.query.flush === 'true';
    if (flush) await pm2Command(`flush ${req.params.id}`);
    await pm2Command(`restart ${req.params.id}`);
    res.json({ message: `프로세스 ${req.params.id} 재시작 완료` });
  } catch (err: unknown) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/pm2/flush/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    await pm2Command(`flush ${req.params.id}`);
    res.json({ message: `프로세스 ${req.params.id} 로그 초기화 완료` });
  } catch (err: unknown) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/pm2/stop/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    await pm2Command(`stop ${req.params.id}`);
    res.json({ message: `프로세스 ${req.params.id} 중지 완료` });
  } catch (err: unknown) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/pm2/start/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    await pm2Command(`start ${req.params.id}`);
    res.json({ message: `프로세스 ${req.params.id} 시작 완료` });
  } catch (err: unknown) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/pm2/delete/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    await pm2Command(`delete ${req.params.id}`);
    res.json({ message: `프로세스 ${req.params.id} 삭제 완료` });
  } catch (err: unknown) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/pm2/save', authMiddleware, async (_req: Request, res: Response): Promise<void> => {
  try {
    await pm2Command('save');
    res.json({ message: 'PM2 프로세스 목록 저장 완료' });
  } catch (err: unknown) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/pm2/register', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { name, script, cwd, interpreter, args } = req.body as {
    name: string;
    script: string;
    cwd?: string;
    interpreter?: string;
    args?: string;
  };
  try {
    let cmd = `start ${script} --name "${name}"`;
    if (cwd) cmd += ` --cwd "${cwd}"`;
    if (interpreter) cmd += ` --interpreter "${interpreter}"`;
    if (args) cmd += ` -- ${args}`;
    await pm2Command(cmd);
    res.json({ message: `프로세스 "${name}" 등록 완료` });
  } catch (err: unknown) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/pm2/logs/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const { stdout } = await execAsync(`pm2 logs ${req.params.id} --lines 100 --nostream --no-color 2>&1`);
    res.json({ logs: stdout });
  } catch (err: unknown) {
    const error = err as Error;
    res.json({ logs: error.message });
  }
});

app.get('*', (_req: Request, res: Response): void => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Running on http://localhost:${PORT}`);
  console.log(`Password: ${PASSWORD}`);
});

setInterval(broadcastPM2, 1500);

export default app;