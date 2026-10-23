#!/usr/bin/env node

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  createReadStream,
  createWriteStream,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { finished, pipeline } from "node:stream/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAGIC = Buffer.from("TAXICD01", "ascii");
const IV_BYTES = 12;
const TAG_BYTES = 16;

function candidateKey(encoded = process.env.TAXI_RELEASE_CANDIDATE_KEY_BASE64 ?? "") {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
    throw new Error("TAXI_RELEASE_CANDIDATE_KEY_BASE64 must be canonical base64 for exactly 32 bytes");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    throw new Error("TAXI_RELEASE_CANDIDATE_KEY_BASE64 must decode to exactly 32 bytes");
  }
  return key;
}

function assertRegularInput(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1) {
    throw new Error("candidate input must be a non-empty, non-symlink regular file");
  }
  return info;
}

function temporaryOutput(outputPath) {
  return `${outputPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
}

export async function encryptCandidateFile(inputPath, outputPath, encodedKey) {
  assertRegularInput(inputPath);
  const key = candidateKey(encodedKey);
  const iv = randomBytes(IV_BYTES);
  const header = Buffer.concat([MAGIC, iv]);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(header);
  const temporary = temporaryOutput(outputPath);
  try {
    const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
    output.write(header);
    await pipeline(createReadStream(inputPath), cipher, output, { end: false });
    const completion = finished(output);
    output.end(cipher.getAuthTag());
    await completion;
    chmodSync(temporary, 0o600);
    renameSync(temporary, outputPath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function readEnvelope(path) {
  const info = assertRegularInput(path);
  const minimumSize = MAGIC.length + IV_BYTES + TAG_BYTES + 1;
  if (info.size < minimumSize) throw new Error("encrypted candidate is truncated");
  const descriptor = openSync(path, "r");
  try {
    const header = Buffer.alloc(MAGIC.length + IV_BYTES);
    const tag = Buffer.alloc(TAG_BYTES);
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length) {
      throw new Error("encrypted candidate header is truncated");
    }
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("encrypted candidate header is invalid");
    if (readSync(descriptor, tag, 0, tag.length, info.size - TAG_BYTES) !== tag.length) {
      throw new Error("encrypted candidate authentication tag is truncated");
    }
    return {
      header,
      iv: header.subarray(MAGIC.length),
      tag,
      ciphertextStart: header.length,
      ciphertextEnd: info.size - TAG_BYTES - 1,
    };
  } finally {
    closeSync(descriptor);
  }
}

export async function decryptCandidateFile(inputPath, outputPath, encodedKey) {
  const envelope = readEnvelope(inputPath);
  const key = candidateKey(encodedKey);
  const decipher = createDecipheriv("aes-256-gcm", key, envelope.iv);
  decipher.setAAD(envelope.header);
  decipher.setAuthTag(envelope.tag);
  const temporary = temporaryOutput(outputPath);
  try {
    await pipeline(
      createReadStream(inputPath, { start: envelope.ciphertextStart, end: envelope.ciphertextEnd }),
      decipher,
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    if (!statSync(temporary).size) throw new Error("decrypted candidate is empty");
    chmodSync(temporary, 0o600);
    renameSync(temporary, outputPath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new Error(
      `candidate authentication/decryption failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function valueArg(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? "") : "";
}

async function main() {
  const mode = process.argv[2];
  if (mode !== "encrypt" && mode !== "decrypt") throw new Error("first argument must be encrypt or decrypt");
  const input = resolve(valueArg("--input"));
  const output = resolve(valueArg("--output"));
  if (input === output) throw new Error("input and output paths must differ");
  if (mode === "encrypt") await encryptCandidateFile(input, output);
  else await decryptCandidateFile(input, output);
  console.log(`ok: signed candidate ${mode}ed as an authenticated envelope`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`signed-release-candidate: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
