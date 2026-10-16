/**
 * LiveKit agent worker: the live voice claim agent.
 *
 * Voice: an OpenAI speech-to-text, LLM, text-to-speech pipeline (needs OPENAI_API_KEY).
 * Face: a Tavus avatar when TAVUS_API_KEY is set.
 * Claim team: background tools that run on LiveKit Inference and deterministic rules.
 */

import 'dotenv/config';
import { cli, defineAgent, type JobContext, llm, ServerOptions, voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as tavus from '@livekit/agents-plugin-tavus';
import {
  ParticipantKind,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  RoomEvent,
  TrackKind,
  TrackSource,
  VideoBufferType,
  type VideoFrame,
  VideoStream,
} from '@livekit/rtc-node';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { z } from 'zod';
import { type CameraFrame, FRAME_MAX_AGE_MS, IntakeSession, type ToolActivity } from './intake.js';
import {
  cameraModeNotice,
  referenceClock,
  summarizeWorkflowForVoice,
  TOOL_INSTRUCTIONS,
  toolHeadline,
  type ToolName,
  VOICE_INSTRUCTIONS,
} from './prompts.js';

export const AGENT_NAME = 'insurance-claim-agent';
// OpenAI pipeline: low-latency streaming transcription, a fast non-reasoning model, fast TTS.
const STT_MODEL = 'gpt-live-transcribe';
const LLM_MODEL = 'gpt-4.1-mini';
const TTS_MODEL = 'tts-1';
const VOICE = 'nova';
const AVATAR_MODEL_LABEL = 'Tavus Phoenix 4.5';
const FRAME_WIDTH = 512;
const STATE_TOPIC = 'claim.state';
const EVENT_TOPIC = 'claim.event';

/** Latest frame from the claimant's camera, encoded to JPEG only when a capture is requested. */
class CameraTap {
  private frame: VideoFrame | null = null;
  private frameAt = 0;
  private stream: VideoStream | null = null;
  trackSid: string | null = null;

  attach(track: RemoteTrack, sid: string) {
    this.detach();
    this.trackSid = sid;
    const stream = new VideoStream(track);
    this.stream = stream;
    void (async () => {
      try {
        const reader = stream.getReader();
        while (this.stream === stream) {
          const { value, done } = await reader.read();
          if (done) break;
          this.frame = value.frame;
          this.frameAt = Date.now();
        }
        reader.releaseLock();
      } catch {
        // The track ended; the next attach starts a fresh stream.
      }
    })();
  }

  detach() {
    const stream = this.stream;
    this.stream = null;
    this.trackSid = null;
    this.frame = null;
    this.frameAt = 0;
    if (stream) void stream.cancel().catch(() => undefined);
  }

  async latest(): Promise<CameraFrame | null> {
    const frame = this.frame;
    if (!frame || Date.now() - this.frameAt > FRAME_MAX_AGE_MS) return null;
    const rgba = frame.type === VideoBufferType.RGBA ? frame : frame.convert(VideoBufferType.RGBA);
    const jpeg = await sharp(Buffer.from(rgba.data), {
      raw: { width: rgba.width, height: rgba.height, channels: 4 },
    })
      .resize({ width: Math.min(FRAME_WIDTH, rgba.width) })
      .jpeg({ quality: 70 })
      .toBuffer();
    return { jpeg, id: randomUUID().replace(/-/g, '') };
  }
}

class ClaimAgent extends voice.Agent {
  private readonly baseInstructions: string;

  constructor(
    readonly intake: IntakeSession,
    options: voice.AgentOptions<unknown> & { baseInstructions: string },
  ) {
    super(options);
    this.baseInstructions = options.baseInstructions;
  }

  /** Tell the model about app state without putting words in the claimant's mouth. */
  async notifyAppState(notice: string) {
    await this.updateInstructions(`${this.baseInstructions}\n\n${notice}\n${referenceClock()}`);
  }

  /** Add background facts the model should know, without prompting it to speak. */
  async addSilentContext(text: string) {
    const chatCtx = this.chatCtx.copy();
    chatCtx.addMessage({ role: 'system', content: text });
    await this.updateChatCtx(chatCtx);
  }
}

/**
 * Claim-team results go into the agent's context silently. Speaking about every
 * update made the agent repeat itself; only a new safety escalation is spoken.
 */
class ClaimUpdates {
  private lastShared = '';
  private escalated = false;

  constructor(
    private readonly intake: IntakeSession,
    private readonly agent: ClaimAgent,
    private readonly getSession: () => voice.AgentSession | undefined,
    private readonly onError: (message: string) => void,
  ) {}

  async refresh(): Promise<ReturnType<typeof summarizeWorkflowForVoice> | null> {
    let summary: ReturnType<typeof summarizeWorkflowForVoice>;
    try {
      summary = summarizeWorkflowForVoice(await this.intake.runWorkflow());
    } catch (error) {
      if (this.intake.deleted) return null;
      console.error('[workflow] claim update failed', error);
      this.onError('The claim update failed. Your conversation is retained; ask the agent to retry the update.');
      return null;
    }
    const shared = JSON.stringify(summary);
    if (shared !== this.lastShared) {
      this.lastShared = shared;
      await this.agent
        .addSilentContext(
          `CLAIM TEAM UPDATE (background notes, not a claimant statement; do not read aloud): ${shared}`,
        )
        .catch((error) => console.warn('[workflow] could not share claim update', error));
    }
    if (summary.safety_escalation && !this.escalated) {
      this.escalated = true;
      const session = this.getSession();
      if (session) {
        if (session.agentState === 'speaking') {
          try {
            session.interrupt();
          } catch {
            // Uninterruptible speech finishes first.
          }
        }
        session.generateReply({
          instructions:
            'The claim team flagged a current safety, injury, or habitability concern. Tell the claimant once, briefly, ' +
            'to contact emergency services if anyone is in danger, and that a human representative should review the ' +
            'packet. Then continue the intake.',
        });
      }
    }
    if (!summary.safety_escalation) this.escalated = false;
    return summary;
  }
}

function buildTools(
  intake: IntakeSession,
  getSession: () => voice.AgentSession | undefined,
  getUpdates: () => ClaimUpdates,
) {
  /** Shared bookkeeping: activity feed entries, errors, urgent interruption. */
  async function run<T extends Record<string, unknown>>(
    name: ToolName,
    args: Record<string, unknown>,
    toolCallId: string,
    work: () => Promise<T>,
    isUrgent: (result: T) => boolean = () => false,
  ): Promise<T | { error: string }> {
    const started = Date.now();
    const entry: ToolActivity = {
      id: toolCallId,
      name,
      args,
      phase: 'running',
      headline: toolHeadline(name, args, null),
    };
    intake.recordTool(entry);
    try {
      const result = await work();
      const urgent = isUrgent(result);
      intake.recordTool({
        ...entry,
        phase: 'done',
        headline: toolHeadline(name, args, result),
        duration_ms: Date.now() - started,
        result,
        urgent,
      });
      if (urgent) {
        // Urgent results should not wait behind the agent's current sentence.
        const session = getSession();
        if (session?.agentState === 'speaking') {
          try {
            session.interrupt();
          } catch {
            // Speech that cannot be interrupted finishes first; the result is delivered afterwards.
          }
        }
      }
      return result;
    } catch (error) {
      const message = `${name} failed. Continue the conversation and retry if needed.`;
      console.error(`[tool] ${name} failed`, error);
      intake.recordTool({ ...entry, phase: 'error', headline: message, duration_ms: Date.now() - started });
      return { error: message };
    }
  }

  const lookupPolicy = llm.tool({
    name: 'lookup_policy',
    description:
      'Verify an insurance policy number against the demo policy directory. Returns policyholder name, ' +
      'policy line, status, deductibles, and coverages when found.',
    parameters: z.object({
      policy_number: z
        .string()
        .describe('Policy number exactly as the claimant said it, for example 44721 or AUTO-123.'),
    }),
    execute: async (args, { toolCallId }) =>
      run(
        'lookup_policy',
        args,
        toolCallId,
        async () => ({ ...intake.lookupPolicy(args.policy_number) }) as Record<string, unknown>,
        (result) => !result.found || result.status !== 'active',
      ),
  });

  const syncClaimPacket = llm.tool({
    name: 'sync_claim_packet',
    description:
      'Ask the background claim team to refresh the packet from the conversation so far. Returns the latest ' +
      'routing decision, severity, open items, and the next best question right away; fresher results are added ' +
      'to your context silently when the team finishes.',
    parameters: z.object({
      reason: z
        .string()
        .describe("One short phrase on why you are syncing now, for example 'new loss facts' or 'injury mentioned'."),
    }),
    // Returns at once and never schedules a second spoken reply.
    execute: async (args, { toolCallId }) => {
      void run('sync_claim_packet', args, toolCallId, async () => {
        const summary = await getUpdates().refresh();
        if (!summary) throw new Error('Claim update failed');
        return summary as unknown as Record<string, unknown>;
      });
      return {
        status: 'The claim team is refreshing the packet in the background. Do not mention this; keep talking.',
        latest: summarizeWorkflowForVoice(intake.workflow),
      };
    },
  });

  const pinEvidencePhoto = llm.tool({
    name: 'pin_evidence_photo',
    description:
      "Capture the claimant's current camera frame into the claim notebook. The evidence desk independently " +
      'describes the frame and reports whether it supports what the claimant described.',
    parameters: z.object({
      claimant_description: z
        .string()
        .describe("What the claimant says this shows, in their words, for example 'a crack in the wall'. Empty if they did not say."),
      evidence_type: z
        .string()
        .describe("Short category such as 'damage', 'receipt', 'document', 'serial number', or 'scene'."),
    }),
    execute: async (args, { ctx, toolCallId }) => {
      await ctx.update('The evidence desk is looking at the camera frame. Keep the claimant on this view.');
      return run('pin_evidence_photo', args, toolCallId, async () => {
        const result = (await intake.pinEvidencePhoto(args)) as Record<string, unknown>;
        if (result.pinned) void getUpdates().refresh();
        return result;
      });
    },
  });

  const drawIncidentSketch = llm.tool({
    name: 'draw_incident_sketch',
    description:
      'Ask the claim team to draw a rough hand-drawn pen sketch of the incident scene into the notebook. ' +
      'With camera OFF, call automatically once the incident and scene are sufficiently described. With camera ON, ' +
      'use real captures instead; only draw on an explicit request or to correct an existing sketch.',
    parameters: z.object({
      scene_description: z
        .string()
        .describe(
          'Illustrator brief in plain words: the space or intersection, where things are, what got damaged, and the ' +
            'direction of impact or water flow. Include labels to write on the sketch. Fold in any corrections.',
        ),
      trigger: z
        .enum(['automatic', 'explicit_request', 'correction'])
        .describe(
          'automatic for the default camera-off illustration; explicit_request only when the claimant asks for a ' +
            'drawing; correction only when they correct an existing sketch.',
        ),
    }),
    execute: async (args, { ctx, toolCallId }) => {
      await ctx.update('The sketch artist is drawing. Keep the conversation going.');
      return run('draw_incident_sketch', args, toolCallId, async () => (await intake.drawIncidentSketch(args)) as Record<string, unknown>);
    },
  });

  return llm.AsyncToolset.create({
    id: 'claim_team',
    tools: [lookupPolicy, syncClaimPacket, pinEvidencePhoto, drawIncidentSketch],
  });
}

function isClaimant(participant: RemoteParticipant) {
  return participant.kind !== ParticipantKind.AGENT;
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    const room = ctx.room;
    const intake = new IntakeSession();
    const camera = new CameraTap();
    intake.latestFrame = () => camera.latest();

    // Coalesce notebook updates into one state message per tick.
    let pushTimer: NodeJS.Timeout | null = null;
    const pushState = () => {
      if (pushTimer || intake.deleted) return;
      pushTimer = setTimeout(() => {
        pushTimer = null;
        if (!room.isConnected || !room.localParticipant) return;
        room.localParticipant
          .sendText(JSON.stringify(intake.uiState()), { topic: STATE_TOPIC })
          .catch((error) => console.warn('[state] publish failed', error));
      }, 120);
    };
    const pushEvent = (payload: Record<string, unknown>) => {
      room.localParticipant?.sendText(JSON.stringify(payload), { topic: EVENT_TOPIC }).catch(() => undefined);
    };
    intake.onChange = pushState;

    let session: voice.AgentSession | undefined;
    let updates!: ClaimUpdates;
    const toolset = buildTools(intake, () => session, () => updates);

    const baseInstructions = `${VOICE_INSTRUCTIONS}\n\nTools:\n${TOOL_INSTRUCTIONS}`;
    const agent = new ClaimAgent(intake, {
      baseInstructions,
      instructions: `${baseInstructions}\n\n${cameraModeNotice(false)}\n${referenceClock()}`,
      tools: [toolset],
    });
    updates = new ClaimUpdates(intake, agent, () => session, (message) => pushEvent({ type: 'error', message }));

    intake.liveModel = `OpenAI ${STT_MODEL} + ${LLM_MODEL} + ${TTS_MODEL}`;
    session = new voice.AgentSession({
      stt: new openai.STT({ model: STT_MODEL, detectLanguage: true }),
      llm: new openai.LLM({ model: LLM_MODEL }),
      tts: new openai.TTS({ model: TTS_MODEL, voice: VOICE }),
    });

    // Final conversation turns feed the notebook and, for the claimant, the claim team.
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (event) => {
      const item = event.item;
      if (item.type !== 'message' || (item.role !== 'user' && item.role !== 'assistant')) return;
      const text = item.textContent?.trim();
      if (!text) return;
      try {
        intake.appendTurn(item.role === 'user' ? 'Claimant' : 'Agent', text, item.id);
      } catch (error) {
        pushEvent({ type: 'error', message: (error as Error).message });
        return;
      }
      if (item.role === 'user') {
        void updates.refresh();
      }
    });
    session.on(voice.AgentSessionEventTypes.Error, (event) => {
      console.error('[session] error', event.error);
    });

    // The claimant's camera drives camera mode and evidence capture.
    const setCamera = (enabled: boolean) => {
      if (intake.setCameraMode(enabled)) void agent.notifyAppState(cameraModeNotice(enabled)).catch(() => undefined);
    };
    room.on(
      RoomEvent.TrackSubscribed,
      (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (track.kind !== TrackKind.KIND_VIDEO || publication.source !== TrackSource.SOURCE_CAMERA) return;
        if (!isClaimant(participant)) return;
        camera.attach(track, publication.sid ?? '');
        setCamera(true);
      },
    );
    room.on(RoomEvent.TrackUnsubscribed, (_track: RemoteTrack, publication: RemoteTrackPublication) => {
      if (publication.sid && publication.sid === camera.trackSid) {
        camera.detach();
        setCamera(false);
      }
    });
    room.on(RoomEvent.TrackMuted, (publication) => {
      if (publication.sid && publication.sid === camera.trackSid) setCamera(false);
    });
    room.on(RoomEvent.TrackUnmuted, (publication) => {
      if (publication.sid && publication.sid === camera.trackSid) setCamera(true);
    });

    if (process.env.TAVUS_API_KEY) {
      try {
        const avatar = new tavus.AvatarSession({
          faceId: process.env.TAVUS_FACE_ID || undefined,
          palId: process.env.TAVUS_PAL_ID || undefined,
          avatarParticipantName: 'Claim assistant',
        });
        await avatar.start(session, room);
        intake.avatar = { enabled: true, name: 'Tavus avatar' };
        intake.liveModel = `${intake.liveModel} + ${AVATAR_MODEL_LABEL}`;
      } catch (error) {
        console.error('[avatar] Tavus avatar failed to start; continuing voice-only', error);
        pushEvent({ type: 'error', message: 'The avatar could not start. Continuing with voice only.' });
      }
    }

    ctx.addShutdownCallback(async () => {
      intake.close();
      camera.detach();
    });

    await session.start({ agent, room });
    pushState();
    session.generateReply({
      instructions:
        'Greet the claimant in one short sentence as their AI claim assistant, say you can start the claim while ' +
        'you talk, and ask whether they and everyone else are in a safe place. Then stop and listen.',
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME }));
