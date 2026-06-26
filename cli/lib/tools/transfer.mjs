// download / upload 工具：本地与远程之间传文件，底层用 scp。
//  - upload <local> <remote>   本地 → 远程
//  - download <remote> <local> 远程 → 本地
import { buildScpParts, runScp } from '../ssh.mjs';
import { ok, fail } from '../output.mjs';

export const uploadUsage = `upload <local_path> <remote_path>`;
export const downloadUsage = `download <remote_path> <local_path>`;

export async function runUpload(target, positional) {
  const local = positional[0];
  const remote = positional[1];
  if (!local || !remote) {
    return fail('upload 需要 <local_path> <remote_path>。\n' + uploadUsage);
  }
  const { portArgs, remotePrefix } = buildScpParts(target);
  const dest = `${remotePrefix}:${remote}`;
  const r = await runScp([...portArgs, '-r', local, dest], { timeoutMs: 300_000 });
  if (r.code !== 0) {
    return fail(`上传失败: ${r.stderr.trim() || '未知错误'}`);
  }
  return ok({ data: { local, remote }, text: `已上传 ${local} → ${dest}` });
}

export async function runDownload(target, positional) {
  const remote = positional[0];
  const local = positional[1];
  if (!remote || !local) {
    return fail('download 需要 <remote_path> <local_path>。\n' + downloadUsage);
  }
  const { portArgs, remotePrefix } = buildScpParts(target);
  const src = `${remotePrefix}:${remote}`;
  const r = await runScp([...portArgs, '-r', src, local], { timeoutMs: 300_000 });
  if (r.code !== 0) {
    return fail(`下载失败: ${r.stderr.trim() || '未知错误'}`);
  }
  return ok({ data: { remote, local }, text: `已下载 ${src} → ${local}` });
}
