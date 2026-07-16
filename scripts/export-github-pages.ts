import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDataset } from "../lib/live-data";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "docs");

async function main() {
  const { summary, histories } = await getDataset(true);
  const sourceHtml = await readFile(path.join(root, "public/dashboard.html"), "utf8");
  const html = sourceHtml
    .replace('<html lang="zh-CN">', '<html lang="zh-CN" data-host-mode="static">')
    .replace('href="/static-app.css"', 'href="./static-app.css"')
    .replace('src="/static-app.js"', 'src="./static-app.js"')
    .replace("PRIVATE TERMINAL", "PUBLIC DASHBOARD")
    .replace("仅本人可见", "持仓数据仅存本机")
    .replace("立即更新行情", "重新读取公开行情")
    .replace("立即更新行情", "重新读取公开行情");

  await rm(output, { recursive: true, force: true });
  await mkdir(path.join(output, "data/history"), { recursive: true });
  await Promise.all([
    writeFile(path.join(output, "index.html"), html),
    writeFile(path.join(output, ".nojekyll"), ""),
    cp(path.join(root, "public/static-app.css"), path.join(output, "static-app.css")),
    cp(path.join(root, "public/static-app.js"), path.join(output, "static-app.js")),
    writeFile(path.join(output, "data/summary.json"), JSON.stringify(summary)),
    writeFile(
      path.join(output, "data/history/NDX.json"),
      JSON.stringify({ symbol: "^NDX", history: histories["^NDX"] || [] }),
    ),
    writeFile(
      path.join(output, "data/history/CSI300.json"),
      JSON.stringify({ symbol: "000300.SS", history: histories["000300.SS"] || [] }),
    ),
  ]);

  console.log(`GitHub Pages snapshot exported to ${output}`);
}

await main();
