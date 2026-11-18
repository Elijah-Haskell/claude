import { test } from "node:test";
import assert from "node:assert/strict";
import * as zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, readZip, writeZip, zipEntryNames, ZipError } from "../../src/documents/zip.ts";
import { tempDir } from "./helpers.ts";

test("zip: crc32 matches known values and node:zlib", () => {
  assert.equal(crc32(Buffer.from("")), 0);
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926); // the standard check value
  const big = Buffer.alloc(100_000, 0).map((_, i) => (i * 31) & 0xff) as Buffer;
  if (typeof (zlib as any).crc32 === "function") assert.equal(crc32(big), (zlib as any).crc32(big));
});

test("zip: write then read round-trips stored, deflated, empty and UTF-8-named entries", () => {
  const entries = [
    { name: "a.txt", data: Buffer.from("hello ".repeat(1000)) }, // compresses: deflated
    { name: "rand.bin", data: Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 97 + 13) & 0xff)) }, // stored
    { name: "empty.txt", data: Buffer.alloc(0) },
    { name: "dir/Señor café.xml", data: Buffer.from("<x>é</x>") },
  ];
  const zip = writeZip(entries);
  assert.deepEqual(zipEntryNames(zip), entries.map((e) => e.name));
  const back = readZip(zip);
  assert.equal(back.length, 4);
  for (let i = 0; i < 4; i++) {
    assert.equal(back[i].name, entries[i].name);
    assert.ok(back[i].data.equals(entries[i].data));
  }
  assert.ok(zip.length < 2000, "repetitive text was compressed");
  // `only` skips entries without inflating them
  assert.deepEqual(readZip(zip, { only: (n) => n.endsWith(".xml") }).map((e) => e.name), ["dir/Señor café.xml"]);
});

test("zip: rejects corrupt and hostile archives", () => {
  const zip = writeZip([{ name: "a.txt", data: Buffer.from("some text that is long enough ".repeat(20)) }]);
  assert.throws(() => readZip(Buffer.from("not a zip at all")), ZipError);
  // Flip a byte of compressed data: either inflate fails or the CRC check does.
  const bad = Buffer.from(zip);
  bad[40] ^= 0xff;
  assert.throws(() => readZip(bad), ZipError);
  // Truncated
  assert.throws(() => readZip(zip.subarray(0, zip.length - 30)), ZipError);
  // Zip bomb guard
  const bomb = writeZip([{ name: "zeros", data: Buffer.alloc(5_000_000) }]);
  assert.ok(bomb.length < 20_000);
  assert.throws(() => readZip(bomb, { maxTotal: 1_000_000 }), /more data than allowed/);
  // Writer refuses unsafe names and duplicates
  assert.throws(() => writeZip([{ name: "../evil", data: Buffer.alloc(1) }]), ZipError);
  assert.throws(() => writeZip([{ name: "/abs", data: Buffer.alloc(1) }]), ZipError);
  assert.throws(() => writeZip([{ name: "x", data: Buffer.alloc(1) }, { name: "x", data: Buffer.alloc(1) }]), /Duplicate/);
});

const python = spawnSync("python3", ["-I", "-c", "import zipfile"]).status === 0;

test("zip: Python's zipfile accepts our archives and we read Python's", { skip: !python && "python3 not available" }, () => {
  const { dir, cleanup } = tempDir();
  try {
    const ours = join(dir, "ours.zip");
    writeFileSync(ours, writeZip([{ name: "a.txt", data: Buffer.from("alpha ".repeat(500)) }, { name: "b/c.txt", data: Buffer.from("beta") }]));
    const r = spawnSync(
      "python3",
      ["-I", "-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(z.read('b/c.txt').decode())", ours],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "beta");

    const theirs = join(dir, "theirs.zip");
    const w = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        "import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:\n  z.writestr('x.txt','gamma '*300)\n  z.writestr('y.txt','delta', compress_type=zipfile.ZIP_STORED)",
        theirs,
      ],
      { encoding: "utf8" },
    );
    assert.equal(w.status, 0, w.stderr);
    const entries = readZip(readFileSync(theirs));
    assert.equal(entries.find((e) => e.name === "x.txt")!.data.toString(), "gamma ".repeat(300));
    assert.equal(entries.find((e) => e.name === "y.txt")!.data.toString(), "delta");
  } finally {
    cleanup();
  }
});
