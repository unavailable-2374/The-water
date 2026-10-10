/** Opt-in REAL evaluations. Never log credentials or silently try alternate sources. */
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export function evaluationCredential() {
  const file=process.env.REAL_EVAL_ENV_FILE;
  const source=file ? resolve(file) : 'process.env.LUNAROUTE_API_KEY';
  const key=file ? parseEnv(readFileSync(source,'utf8')).LUNAROUTE_API_KEY : process.env.LUNAROUTE_API_KEY;
  if(!key)throw new Error(`LUNAROUTE_API_KEY is required in ${source}`);
  return {key,source};
}
export function evaluationSource() {
  const root=execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim();
  const files=execFileSync('git',['-C',root,'ls-files','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(p=>/^(apps|packages)\/.*\.tsx?$/.test(p));
  return {
    head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    diffSha256:createHash('sha256').update(execFileSync('git',['diff','HEAD'])).digest('hex'),
    untrackedSourceSha256:Object.fromEntries(files.map(p=>[p,createHash('sha256').update(readFileSync(resolve(root,p))).digest('hex')])),
  };
}
