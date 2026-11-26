import { open, unlink } from 'node:fs/promises';

export async function writeNewFile(path, data) {
  const file = await open(path, 'wx');
  try {
    try {
      await file.writeFile(data);
    } finally {
      await file.close();
    }
  } catch (error) {
    await unlink(path);
    throw error;
  }
}
