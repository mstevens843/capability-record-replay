// Rewrite the committed synthetic VCR fixture.
//
//   pnpm -F @crr/discovery fixtures:synthetic
//
// Run this when the system prompt, the tool definitions, the projection or the loop's message
// shape changes - `test/vcr.test.ts` fails until you do, which is the whole point: a prompt change
// that nobody re-recorded is a prompt change nobody has ever sent.
//
// It makes no network call and needs no credentials. What it writes is SYNTHETIC and is not
// evidence of a discovery run; see the header of `build-transcript.ts`.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CASSETTE_FILE, buildCassette } from "./build-openai-cassette.js";
import { FIXTURE_FILE, buildSyntheticTranscript } from "./build-transcript.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const { transcript, run } = await buildSyntheticTranscript();

writeFileSync(join(here, FIXTURE_FILE), `${JSON.stringify(transcript, null, 2)}\n`, "utf8");

process.stdout.write(
  `wrote ${FIXTURE_FILE}: ${transcript.turns.length} turns, ${transcript.toolCalls.length} tool calls, ` +
    `run status "${run.status}", ${run.steps.length} recorded steps\n`,
);

// The OpenAI HTTP cassette is written from the SAME script, so the two providers can never drift
// into driving different conversations - which is the only condition under which "the same loop
// completes against a second provider" says anything at all.
const cassette = buildCassette();
writeFileSync(join(here, CASSETTE_FILE), `${JSON.stringify(cassette, null, 2)}\n`, "utf8");
process.stdout.write(`wrote ${CASSETTE_FILE}: ${cassette.exchanges.length} exchanges\n`);
