import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const build = path.join(root, 'frontend-vue/dist');
const html = fs.readFileSync(path.join(build, 'index.html'), 'utf8');
const script = html.match(/<script type="module" crossorigin src="\/assets\/index-[^"]+\.js"><\/script>/)?.[0];
const stylesheet = html.match(/<link rel="stylesheet" crossorigin href="\/assets\/index-[^"]+\.css">/)?.[0];
if (!script || !stylesheet) throw new Error('Vue build entry or stylesheet missing; run npm --prefix frontend-vue run build first');
for (const name of fs.readdirSync(path.join(build, 'assets'))) {
  const source = path.join(build, 'assets', name);
  if (fs.statSync(source).isFile()) {
    const target=path.join(root, 'public/assets', name);
    const normalize=buffer=>buffer.toString('utf8').replace(/\r\n/g,'\n');
    if (!fs.existsSync(target) || normalize(fs.readFileSync(source)) !== normalize(fs.readFileSync(target))) fs.copyFileSync(source, target);
  }
}
const shellPath = path.join(root, 'public/index.html');
let shell = fs.readFileSync(shellPath, 'utf8');
shell = shell.replace(/<script type="module" crossorigin src="\/assets\/index-[^"]+\.js"><\/script>/, script)
  .replace(/<link rel="stylesheet" crossorigin href="\/assets\/index-[^"]+\.css">/, stylesheet);
const legacy = [...html.matchAll(/    <link rel="stylesheet" href="\/legacy\/[^\n]+/g)].map(match => match[0]);
shell = shell.replace(/^    <link rel="stylesheet" href="\/legacy\/[^\n]+\n/gm, '');
shell = shell.replace('    <link rel="preload"', `${legacy.join('\n')}\n    <link rel="preload"`);
fs.writeFileSync(shellPath, shell);
if (process.argv.includes('--runtime')) {
  // Compose serves frontend-vue/dist; include the same shell and support files tested locally.
  fs.cpSync(path.join(root, 'public'), build, { recursive: true });
}
console.log('Published Vue assets and complete style dependencies; retained historical assets for existing clients.');
