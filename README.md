# Insurance Claim Live Agent Team

An insurance claim agent that talks, listens, looks at damage through your camera, and sketches the incident while the conversation continues. Built in TypeScript on [LiveKit Agents](https://docs.livekit.io/agents/), using OpenAI for the voice and a Tavus avatar for the face.

The agent records details in a field notebook, checks mock policy records, and asks for missing information. A background claim team applies intake rules and prepares a downloadable claim packet with notes, captured evidence, and illustrations for human review.

This is a reimplementation of the [Insurance Claim Live Agent Team](https://github.com/Shubhamsaboo/awesome-llm-apps/tree/main/voice_ai_agents/insurance_claim_live_agent_team) from [awesome-llm-apps](https://github.com/Shubhamsaboo/awesome-llm-apps). The original is built in Python on Google ADK and Gemini Live. This version keeps the same claim workflow, rules, and notebook UI, and runs it on LiveKit Agents with a Tavus avatar instead.

![Live call with the Tavus avatar, field notebook with a pinned evidence photo, transcript, and still-needed checklist](assets/screenshot.png)

## Features

* **Live conversation:** speak or type, with live captions and a running transcript.
* **Avatar:** a Tavus avatar lip-syncs the agent's voice; without a Tavus key the call runs voice only.
* **Camera evidence:** captured frames include captions and verification status.
* **Incident sketches:** illustrations based on the claimant's description, updated after corrections.
* **Claim notebook:** extracted facts, missing information, policy checks, and routing.
* **Packet download:** ZIP with Markdown notes, an evidence manifest, captured photos, and sketches.
* **Desktop layout:** call and camera on the left, notes in the middle, transcript and checklist on the right. Mobile stacks the sections.

## How it fits together

![Architecture: browser, LiveKit room with the voice agent and Tavus avatar, background tools, and the claim team of LLM specialists and deterministic rules](assets/architecture.svg)

| Piece | Runs on | Job |
| --- | --- | --- |
| Voice | OpenAI `gpt-live-transcribe` → `gpt-4.1-mini` → `tts-1` | Transcribes the claimant, decides replies and tool calls, speaks; LiveKit handles turn-taking and barge-in |
| Face | Tavus avatar via `@livekit/agents-plugin-tavus` | Joins the room and lip-syncs the agent's audio |
| Claim team | LiveKit Inference | Extracts facts, classifies the claim, verifies camera frames, draws sketches |
| Rules | Local TypeScript | Validation, coverage and evidence gates, document checklist, fraud and safety routing, Markdown packet |
| Browser | `livekit-client` | Mic, camera, avatar playback, transcript, notebook, packet ZIP |

The voice pipeline needs an `OPENAI_API_KEY`.

## Setup

Requires Node.js 20 or newer and a LiveKit Cloud project.

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

```dotenv
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
TAVUS_API_KEY=...
OPENAI_API_KEY=...        # OpenAI voice pipeline
```

Start the agent worker and the web UI together:

```bash
npm run dev
```

Open [127.0.0.1:4177](http://127.0.0.1:4177/).

* **Talk:** join the call and unmute the mic.
* **Show camera:** share the damage. The agent captures frames as evidence.
* **Text box:** send a typed turn into the same call.
* **Adjuster packet:** preview and download the packet ZIP.
* **New intake:** leave the room and start fresh in a new one.

Each intake is its own LiveKit room and agent job. State lives in that job only. Download the packet before you leave; it is never submitted to an insurer.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Bundle the browser client, then run the agent (dev mode) and web server |
| `npm run agent` | Agent worker only, in dev mode |
| `npm run agent:start` | Agent worker in production mode |
| `npm run web` | Bundle the browser client and serve the UI |
| `npm run typecheck` | Typecheck the Node and browser code |
| `npm run build` | Compile to `dist/` and bundle `public/app.js` |

## Configuration

Restart after changing `.env`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Required | Room connection, token minting, and LiveKit Inference |
| `TAVUS_API_KEY` | Empty | Tavus avatar; empty means voice only |
| `TAVUS_FACE_ID`, `TAVUS_PAL_ID` | Tavus stock | Avatar appearance and PAL. A custom PAL must use `pipeline_mode` `echo` with LiveKit transport |
| `OPENAI_API_KEY` | Required | OpenAI voice pipeline |

### Custom avatar

Without `TAVUS_FACE_ID` and `TAVUS_PAL_ID` the agent uses Tavus's stock avatar. To use your own, create a face (replica) and a PAL in the [Tavus dashboard](https://platform.tavus.io/) and set their IDs in `.env`. The PAL must use `pipeline_mode` `echo` with LiveKit transport, because LiveKit runs the conversation and Tavus only renders the face.

## Camera and sketch behavior

The voice model does not take video input, so it never claims to see the camera itself. When the claimant shows something, the agent calls the evidence tool. That tool grabs the newest frame from the claimant's LiveKit video track, has the vision model describe it independently, and reports back what is actually visible.

| Input | Behavior |
| --- | --- |
| Camera off, with enough incident detail | Draw an illustration |
| Camera on, showing damage | Capture and independently verify the frame |
| Unclear camera view | Ask for a clearer view |
| Explicit diagram request | Draw in either camera mode |
| Correction to a sketch | Redraw using the corrected details |

* Greetings, vague descriptions, and no-loss inspections do not trigger automatic sketches.
* Sketches are illustrations, not photographic evidence. They are model-written SVG, sanitized before display.
* Documents described as available are not marked received until a capture succeeds.
* The avatar's video never counts as evidence; only the claimant's camera track is captured.

## Background tools

`lookup_policy`, `sync_claim_packet`, `pin_evidence_photo`, and `draw_incident_sketch` run in a LiveKit `AsyncToolset`. Each slow tool reports progress right away, so the conversation keeps going, and its result is delivered when the agent is next idle. A safety escalation or a lapsed or unknown policy interrupts the agent's current sentence. The claim team also reruns after every finalized claimant turn and caches the result by transcript revision.

## Try a claim

Use this fictional example with the camera off:

> I'm Adam Singh, policy 44721. Our basement flooded when the sump pump failed.
>
> Nobody is hurt. Water entered by the stairs and spread across the carpet toward the boxes.

### Mock policies

| Policy | Policyholder | Type | Status |
| --- | --- | --- | --- |
| 44721 | Adam Singh | Homeowners | Active |
| AUTO-123 | Jordan Lee | Auto | Active |
| RNT-3008 | Priya Shah | Renters | Active |
| TRV-7711 | Alex Chen | Travel | Active |
| MED-5520 | Sam Rivera | Medical reimbursement | Active |
| AUTO-11111 | Chris Park | Auto | Lapsed |

Unknown, lapsed, mismatched, and out-of-period policies route to human review. These records are examples, not a carrier connection.

## Code map

| Path | Responsibility |
| --- | --- |
| `src/agent.ts` | LiveKit worker: voice model, Tavus avatar, camera tap, background tools, state publishing |
| `src/intake.ts` | Per-call state, cached claim workflow, evidence capture, sketches, notebook state |
| `src/prompts.ts` | Voice persona, tool rules, camera notices, sketch prompt |
| `src/claim/workflow.ts` | Claim team: Inference extraction and classification, then the rule pipeline |
| `src/claim/policies.ts`, `schemas.ts` | Deterministic rules, routing, packet, and Zod schemas |
| `src/claim/policyDirectory.ts` | Mock policy records |
| `src/server.ts` | Local web server and LiveKit token minting with agent dispatch |
| `src/web/app.ts` | Browser client, bundled to `public/app.js` |
| `public/` | HTML shell and styles |

The browser and agent talk over LiveKit text streams. The agent publishes notebook state on `claim.state` and errors on `claim.event`. Typed turns go to the agent on `lk.chat`, and live captions arrive on `lk.transcription`.
