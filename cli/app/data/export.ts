/**
 * "Export report": one run's folder as a zip that opens offline (report.html beside its video and
 * photos). The $0 stand-in for share links others can open (APP-PLAN section 4).
 *
 * C26: only plain servable files go in (no folders, no dot files), and never a session, auth, secret,
 * cookie or config file, whatever its name. The files are leak-checked against the run's known
 * secrets before anything is written; a hit refuses the export and names the value and the file,
 * never the value itself. The zip is written owner-only (0600).
 *
 * The zip is written here with node:zlib (deflate) and a CRC-32 table: no dependency.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { leakHits, type Place } from "../../leak.ts";
import { SERVABLE } from "./history.ts";
import { DataError, ownerDir, writeOwnerOnly } from "./util.ts";

/**
 * Never exported, whatever else is true of the name. rating.json too: the person's Helpful / Not
 * helpful note stays in the run folder and is never sent anywhere (C14).
 */
export const NEVER = /(session|auth|secret|cookie|storage[-_]?state|config|credential|token|\.env|^rating\.json$)/i;
const MAX_FILE = 200 * 1024 * 1024;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d: Date): { time: number; date: number } {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2), date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

/** A zip of name → bytes (deflated; stored when deflate doesn't help, as for a video). */
export function zip(files: { name: string; data: Buffer }[], at = new Date()): Buffer {
  const { time, date } = dosTime(at);
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data);
    const deflated = deflateRawSync(f.data);
    const stored = deflated.length >= f.data.length;
    const body = stored ? f.data : deflated;
    const method = stored ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

/** The files of a run folder that may leave it. */
export function exportable(runDir: string): string[] {
  return readdirSync(runDir)
    .filter((n) => SERVABLE.test(n) && !NEVER.test(n))
    .filter((n) => {
      const st = statSync(join(runDir, n), { throwIfNoEntry: false });
      return Boolean(st?.isFile() && st.size <= MAX_FILE);
    })
    .sort();
}

/** Writes <outDir>/<name>.zip from a run folder, after the leak check. Returns its path. */
export function exportRun(runDir: string, outDir: string, o: { name: string; secrets?: Record<string, string>; now?: Date }): string {
  const names = exportable(runDir);
  if (!names.includes("result.json")) throw new DataError(404, "That run has no result to export.");
  const files = names.map((name) => ({ name, data: readFileSync(join(runDir, name)) }));
  const places: Place[] = files.map((f) => ({ where: f.name, text: f.data.toString(/\.(webm|jpe?g|png)$/i.test(f.name) ? "latin1" : "utf8") }));
  const hits = leakHits(o.secrets ?? {}, places);
  if (hits.length) throw new DataError(409, `Not exported: ${hits.map((h) => `${h.value} (${h.form}) in ${h.where}`).join("; ")}. Nothing was written.`);
  ownerDir(outDir);
  const now = o.now ?? new Date();
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const safe = o.name.replace(/[^\w.-]+/g, "-").replace(/^[.-]+|-+$/g, "").slice(0, 60) || "run";
  const path = join(outDir, `${safe}-${stamp}.zip`);
  writeOwnerOnly(path, zip(files, now));
  return path;
}
