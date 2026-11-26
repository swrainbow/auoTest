const { closeSync, mkdirSync, openSync } = require('node:fs');
const { join } = require('node:path');

// Prisma 5's Windows CLI can fail before schema push when the SQLite file does not exist yet.
const storage = join(__dirname, '../../../storage');
mkdirSync(storage, { recursive: true });
closeSync(openSync(join(storage, 'app.db'), 'a'));
