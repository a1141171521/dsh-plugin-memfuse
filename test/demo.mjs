import os from "node:os"; import path from "node:path"; import fsp from "node:fs/promises";
import { MemoryStore } from "../lib/store.js";
import * as policy from "../lib/policy.js";
import { buildInjection } from "../lib/inject.js";

const root = path.join(os.tmpdir(), `dsh-demo-${Date.now()}`);
const cfg = { root, git:false, lifecycle:{p1Days:30,p2Days:7} };
const s = new MemoryStore(cfg, {log(){},warn(){}});
await s.init();
const now = new Date().toISOString();
await s.write({ id:"m_a1", scope:"workspace", kind:"convention", priority:"P1", confidence:0.95,
  title:"本仓库统一用 pnpm", summary:"所有 install 与 script 使用 pnpm，禁止 npm。",
  anchor:"安装依赖、运行脚本、或编写包管理命令时", tags:["pnpm","tooling"],
  source:"auto", lifecycle:"active", created:now, updated:now,
  expires: policy.computeExpiry("P1", cfg.lifecycle), stats:{recalled:4,injected:3,positive:2,negative:0},
  body:"用户明确要求：本仓库从今往后统一用 pnpm 安装依赖、运行脚本，npm 不再使用。" });
await s.write({ id:"m_b2", scope:"workspace", kind:"constraint", priority:"P0", confidence:1,
  title:"回答一律用简体中文", summary:"所有回复使用简体中文。", anchor:"任何对话开始时",
  tags:["lang"], source:"user", managedBy:"user", lifecycle:"active", created:now, updated:now,
  expires:null, stats:{recalled:9,injected:9,positive:5,negative:0}, body:"用户要求：回复一律使用简体中文。" });
await s.rebuildIndex();

console.log("=".repeat(70));
console.log("1) 磁盘上的单条记忆文件：");
console.log("=".repeat(70));
console.log(await fsp.readFile(path.join(root,"memories","m_a1.md"),"utf8"));

console.log("=".repeat(70));
console.log("2) 自动生成的 index.md：");
console.log("=".repeat(70));
console.log(await fsp.readFile(path.join(root,"index.md"),"utf8"));

console.log("=".repeat(70));
console.log("3) 每轮注入进提示词的块：");
console.log("=".repeat(70));
const inj = buildInjection(await s.list(), "我要装个依赖，用 npm 还是 pnpm？", {ok:true}, {});
console.log(inj.text);
console.log("\n--- tokens ≈", inj.tokens, "| 条目:", JSON.stringify(inj.entries));

console.log("\n" + "=".repeat(70));
console.log("4) 管线故障时的注入（Codex 缺的就是这个）：");
console.log("=".repeat(70));
const bad = buildInjection(await s.list(), "我要装个依赖", {ok:false, reason:"503 model unavailable", sinceDays:21}, {});
console.log(bad.text);
await fsp.rm(root,{recursive:true,force:true});
