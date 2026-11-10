import { readFileSync } from "node:fs";
const { instance } = await WebAssembly.instantiate(readFileSync(process.argv[2]));
for (const [seed, n] of [[1n, 10000n], [42n, 10000n], [0xdeadbeefn, 10000n], [7n, 100000n]]) {
  const h = BigInt.asUintN(64, instance.exports.run(seed, n));
  console.log(`${seed} ${n} ${h.toString(16).padStart(16, "0")}`);
}
