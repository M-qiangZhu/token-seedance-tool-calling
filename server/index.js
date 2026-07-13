import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 18081);
const staticDir = process.env.NODE_ENV === 'production' ? path.resolve(dirname, '../dist') : undefined;
const app = createApp({ staticDir });

app.listen(port, () => {
  console.log(`TokenHub Seedance API listening on http://localhost:${port}`);
});
