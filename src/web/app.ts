/**
 * Browser client: joins the LiveKit room, publishes microphone and camera, plays
 * the agent's voice and Tavus video, and renders the field notebook from the
 * state the agent publishes on the `claim.state` text stream.
 */

import JSZip from 'jszip';
import {
  type Participant,
  ParticipantKind,
  type RemoteParticipant,
  type RemoteTrack,
  Room,
  RoomEvent,
  type TextStreamReader,
  Track,
} from 'livekit-client';

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector(selector) as T;

const transcriptEl = $('#transcript');
const notesEl = $('#notes');
const pinboardEl = $('#pinboard');
const stampEl = $('#stamp');
const penEl = $('#pen');
const neededListEl = $('#neededList');
const teamFeedEl = $('#teamFeed');
const readinessEl = $('#readiness');
const callStatus = $('#callStatus');
const modelLabel = $('#modelLabel');
const pageDate = $('#pageDate');
const pageAgent = $('#pageAgent');
const micButton = $<HTMLButtonElement>('#micButton');
const cameraButton = $<HTMLButtonElement>('#cameraButton');
const cameraStage = $('#cameraStage');
const cameraPreview = $<HTMLVideoElement>('#cameraPreview');
const newIntakeButton = $<HTMLButtonElement>('#newIntakeButton');
const textForm = $<HTMLFormElement>('#textForm');
const textInput = $<HTMLInputElement>('#textInput');
const packetDialog = $<HTMLDialogElement>('#packetDialog');
const packetMarkdownEl = $('#packetMarkdown');
const avatarStage = $('#avatarStage');
const avatarVideo = $<HTMLVideoElement>('#avatarVideo');
const avatarName = $('#avatarName');
const avatarStatus = $('#avatarStatus');
const resumeAvatar = $<HTMLButtonElement>('#resumeAvatar');
const audioSink = $('#audioSink');

type Field = { label: string; value: string; status: 'complete' | 'missing' | 'urgent'; source: string };
type Turn = { id: string; speaker: 'Claimant' | 'Agent' | 'System'; text: string; streaming?: boolean };
type ToolEntry = {
  id: string;
  name: string;
  phase: 'running' | 'done' | 'error' | 'cancelled';
  headline: string;
  duration_ms?: number;
  urgent?: boolean;
  result?: Record<string, any>;
};
type Photo = {
  id: string;
  data_url: string;
  caption: string;
  claimant_description: string;
  confirmed: boolean;
  evidence_type: string;
  captured_at: string;
};
type ClaimState = {
  session_id?: string;
  route: string;
  progress: number;
  processing?: boolean;
  fields: Record<string, Field>;
  transcript: Turn[];
  tool_activity: ToolEntry[];
  missing_blockers: string[];
  required_facts?: Array<{ key: string; label: string; done: boolean; value: string }>;
  open_questions?: string[];
  documents: Array<{ item: string; status: string; already_provided: boolean }>;
  evidence_photos: Photo[];
  evidence_manifest: Array<Record<string, unknown>>;
  sketch: { data_url: string; version: number } | null;
  policy: any;
  packet_markdown: string;
  live_model?: string;
  claim_model?: string;
  sketch_model?: string;
  avatar?: { enabled: boolean; name: string };
};

const emptyState: ClaimState = {
  route: 'needs_docs',
  progress: 0,
  fields: {},
  transcript: [],
  tool_activity: [],
  missing_blockers: [],
  documents: [],
  evidence_photos: [],
  evidence_manifest: [],
  sketch: null,
  policy: null,
  packet_markdown: '# Adjuster handoff\n\nNo packet yet.',
};

const routeLabels: Record<string, [string, string]> = {
  emergency_escalation: ['Escalate to human', 'danger'],
  policy_review: ['Policy review', 'warning'],
  needs_docs: ['Needs docs', 'warning'],
  special_investigation: ['SIU review', 'info'],
  ready_for_adjuster: ['Ready for adjuster', 'success'],
};

const blockerQuestions: Record<string, string> = {
  policyholder_name: 'Name?',
  policy_number: 'Policy number?',
  contact_method: 'Best contact?',
  date_of_loss: 'When did it happen?',
  loss_location: 'Where?',
  loss_description: 'What happened?',
};

const teamLabels: Record<string, string> = {
  lookup_policy: 'Policy desk',
  sync_claim_packet: 'Claim writer',
  pin_evidence_photo: 'Evidence',
  draw_incident_sketch: 'Sketch artist',
};

let state: ClaimState = { ...emptyState };
let room: Room | null = null;
let connecting: Promise<Room> | null = null;
let generation = 0;
let micOn = false;
let cameraOn = false;
const localTurns: Turn[] = [];
/** Live captions. `baseline` is how many final turns the speaker had when the caption began. */
const interimTurns = new Map<string, Turn & { baseline: number }>();
const seenNotes = new Set<string>();

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function isFilled(field?: Field): field is Field {
  if (!field || field.status === 'missing') return false;
  return !/^(missing:|not captured|not specified|unknown|none)/i.test(String(field.value || '').trim());
}

function shortBlocker(blocker: string): string {
  if (blockerQuestions[blocker]) return blockerQuestions[blocker]!;
  let text = String(blocker).replace(/\s*\([^)]*\)/g, '').trim();
  if (text.length > 42) text = `${text.slice(0, 40).trim()}...`;
  return text.endsWith('?') ? text : `${text}?`;
}

function setStatus(text: string, tone = '') {
  callStatus.textContent = text;
  callStatus.className = `pill ${tone}`.trim();
}

function setAvatarStatus(text: string, stageState = 'idle') {
  avatarStatus.textContent = text;
  avatarStage.dataset.state = stageState;
}

function claimantHasSpoken(): boolean {
  return visibleTranscript().some((turn) => turn.speaker === 'Claimant' && turn.text.trim());
}

const normalizeText = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function finalTurnCount(speaker: Turn['speaker']): number {
  return state.transcript.filter((turn) => turn.speaker === speaker).length;
}

/**
 * A caption is covered once the agent's authoritative transcript holds it. Captions arrive
 * as sentence segments that rarely match a whole message, so match by turn order first and
 * fall back to text containment for captions that land after their message.
 */
function captionCovered(turn: Turn & { baseline: number }): boolean {
  if (finalTurnCount(turn.speaker) > turn.baseline) return true;
  const caption = normalizeText(turn.text);
  if (!caption) return true;
  return state.transcript
    .filter((final) => final.speaker === turn.speaker)
    .slice(-3)
    .some((final) => normalizeText(final.text).includes(caption));
}

function pruneCaptions() {
  for (const [id, turn] of interimTurns) if (captionCovered(turn)) interimTurns.delete(id);
}

function visibleTranscript(): Turn[] {
  const known = new Set(state.transcript.map((turn) => turn.id));
  return [
    ...state.transcript,
    ...localTurns.filter((turn) => !known.has(turn.id)),
    ...[...interimTurns.values()].filter((turn) => !known.has(turn.id) && !captionCovered(turn)),
  ];
}

function render() {
  renderTranscript();
  renderNotes();
  renderPinboard();
  renderNeeded();
  renderTeam();
  renderStamp();
  packetMarkdownEl.textContent = state.packet_markdown || emptyState.packet_markdown;
}

function renderTranscript() {
  transcriptEl.innerHTML = visibleTranscript()
    .map((turn) => {
      const cls = turn.speaker === 'Agent' ? 'agent' : turn.speaker === 'System' ? 'system' : 'claimant';
      const who = turn.speaker === 'Agent' ? 'AI' : turn.speaker === 'System' ? '!' : 'You';
      return `<article class="turn ${cls} ${turn.streaming ? 'streaming' : ''}"><span class="who">${who}</span><p>${escapeHtml(turn.text)}</p></article>`;
    })
    .join('');
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

type Note = { key: string; cls: string; text: string; blank?: boolean };

function buildNotes(): Note[] {
  const f = state.fields || {};
  const notes: Note[] = [];
  const name = isFilled(f.claimant) ? f.claimant.value : '';
  const policy = isFilled(f.policy) ? f.policy.value : '';
  if (name || policy) notes.push({ key: `title:${name}|${policy}`, cls: 'title', text: [name, policy].filter(Boolean).join('  ·  ') });
  const record = state.policy;
  if (record) {
    if (record.found) {
      const active = record.status === 'active';
      const extras = (record.coverages || []).slice(0, 1).join('');
      notes.push({
        key: `policy:${record.policy_number}:${record.status}`,
        cls: active ? 'check' : 'flag urgent',
        text: active ? `${record.policy_line}, active. ${extras}` : `${record.policy_line}, ${record.status}. Human review before anything else.`,
      });
    } else {
      notes.push({ key: `policy:notfound:${record.policy_number}`, cls: 'flag urgent', text: `Policy ${record.policy_number || ''} not found, confirm the number.` });
    }
  }
  const when = isFilled(f.date) ? f.date.value : '';
  const where = isFilled(f.location) ? f.location.value : '';
  if (when || where) notes.push({ key: `whenwhere:${when}|${where}`, cls: '', text: [where, when].filter(Boolean).join(', ') });
  if (isFilled(f.description)) notes.push({ key: `desc:${f.description.value}`, cls: '', text: f.description.value });
  if (isFilled(f.injuries)) {
    const urgent = f.injuries.status === 'urgent';
    notes.push({ key: `inj:${f.injuries.value}`, cls: urgent ? 'flag urgent' : '', text: urgent ? `Injury: ${f.injuries.value}` : f.injuries.value });
  }
  if (isFilled(f.contact)) notes.push({ key: `contact:${f.contact.value}`, cls: 'aside', text: `Reach at ${f.contact.value}` });
  if (isFilled(f.photos)) notes.push({ key: `ev:${f.photos.value}`, cls: 'aside', text: `Has: ${f.photos.value}` });
  if (isFilled(f.police)) notes.push({ key: `rep:${f.police.value}`, cls: 'aside', text: `Report: ${f.police.value}` });
  if (claimantHasSpoken()) {
    const seenQuestions = new Set<string>();
    for (const blocker of state.missing_blockers || []) {
      const question = shortBlocker(blocker);
      const dedupe = question.toLowerCase().replace(/[^a-z]/g, '');
      if (seenQuestions.has(dedupe) || seenQuestions.size >= 3) continue;
      seenQuestions.add(dedupe);
      notes.push({ key: `blank:${blocker}`, cls: 'blank', text: question, blank: true });
    }
  }
  if (!notes.length) notes.push({ key: 'empty', cls: 'aside', text: 'Waiting for the claimant. Tap Talk, show the camera, or type below.' });
  return notes;
}

function renderNotes() {
  notesEl.innerHTML = buildNotes()
    .map((note) => {
      const fresh = !seenNotes.has(note.key);
      seenNotes.add(note.key);
      return `<div class="note ${note.cls} ${fresh ? 'ink-in' : ''}">${escapeHtml(note.text)}${note.blank ? '<span class="blank-line"></span>' : ''}</div>`;
    })
    .join('');
}

function renderPinboard() {
  const photos = state.evidence_photos || [];
  const sketch = state.sketch;
  const cards = photos.map(
    (photo, index) => `
      <figure class="polaroid" style="--tilt: ${index % 2 ? 2 : -2.5}deg" data-key="${escapeHtml(photo.id)}">
        <img src="${escapeHtml(photo.data_url)}" alt="Camera frame pinned as evidence" />
        <figcaption>${escapeHtml(photo.caption)}</figcaption>
        <span class="tag ${photo.confirmed ? '' : 'unconfirmed'}">${photo.claimant_description ? `Claimant says: ${escapeHtml(photo.claimant_description)} · ` : ''}${photo.confirmed ? 'Supported by this image' : 'Claim not confirmed by this image'}</span>
        <span class="tag">Seen on camera ${escapeHtml(photo.captured_at || '')} · ${escapeHtml(photo.evidence_type || 'evidence')}</span>
      </figure>`,
  );
  if (sketch) {
    cards.push(`
      <figure class="polaroid sketch" style="--tilt: 1.5deg" data-key="sketch-${sketch.version}">
        <img src="${escapeHtml(sketch.data_url)}" alt="Hand drawn sketch of the incident scene" />
        <figcaption>Does this look right?</figcaption>
        <span class="tag">Sketch ${sketch.version}, drawn from what you described</span>
      </figure>`);
  }
  const currentKeys = [...pinboardEl.querySelectorAll<HTMLElement>('[data-key]')].map((el) => el.dataset.key).join('|');
  const nextKeys = [...photos.map((photo) => photo.id), sketch ? `sketch-${sketch.version}` : ''].filter(Boolean).join('|');
  if (currentKeys !== nextKeys) pinboardEl.innerHTML = cards.join('');
}

function renderStamp() {
  const route = state.route;
  const [label, tone] = routeLabels[route] || [route, 'warning'];
  stampEl.hidden = !claimantHasSpoken() || isWriting();
  stampEl.textContent = label;
  if (stampEl.dataset.route !== route) {
    stampEl.dataset.route = route;
    stampEl.className = `stamp ${tone}`;
    stampEl.style.animation = 'none';
    void stampEl.offsetWidth;
    stampEl.style.animation = '';
  }
}

const DOCUMENT_STATUS_LABELS: Record<string, string> = {
  received: 'captured',
  available: 'claimant has it, not captured yet',
  planned: 'claimant will get it',
  missing: 'not available yet',
  unknown: 'not discussed yet',
};

function renderNeeded() {
  const items: Array<{ text: string; cls: string }> = [];
  for (const fact of state.required_facts || []) {
    items.push({ text: fact.done ? `${fact.label}: ${fact.value}` : fact.label, cls: fact.done ? 'done' : 'blocker' });
  }
  for (const question of state.open_questions || []) items.push({ text: shortBlocker(question).replace(/\?$/, ''), cls: 'blocker' });
  for (const doc of state.documents || []) {
    const status = DOCUMENT_STATUS_LABELS[doc.status] || doc.status || 'not discussed yet';
    items.push({ text: `${doc.item} — ${status}`, cls: doc.already_provided ? 'done' : '' });
  }
  neededListEl.innerHTML = items.length
    ? items.map((item) => `<li class="${item.cls}"><span class="tick-box"></span><span>${escapeHtml(item.text)}</span></li>`).join('')
    : '<li class="empty">Nothing yet. The list fills in as the claim team reads the call.</li>';
  const progress = Number(state.progress || 0);
  readinessEl.textContent = `${progress}% collected`;
  readinessEl.className = `pill ${progress >= 80 ? '' : progress >= 40 ? 'warning' : 'neutral'}`;
}

function isWriting() {
  return Boolean(state.processing) || (state.tool_activity || []).some((item) => item.phase === 'running');
}

function renderTeam() {
  const activity = [...(state.tool_activity || [])].slice(-6).reverse();
  teamFeedEl.innerHTML = activity.length
    ? activity
        .map((item) => {
          const phase = item.phase || 'running';
          let headline = item.headline || '';
          if (item.name === 'sync_claim_packet' && phase === 'done' && item.result) {
            const facts = (item.result.open_items || []).length;
            const docs = (item.result.open_documents || []).length;
            headline = `${String(item.result.routing_decision || '').replaceAll('_', ' ')}: ${facts} open fact${facts === 1 ? '' : 's'}${docs ? ', documents still needed' : ''}`;
          }
          const meta = phase === 'running' ? 'working' : item.urgent ? 'interrupted the agent' : item.duration_ms != null ? `${item.duration_ms} ms` : '';
          return `<li><span class="team-dot ${phase}"></span><span><span class="team-name">${escapeHtml(teamLabels[item.name] || item.name)}</span> · ${escapeHtml(headline)}</span><span class="team-meta ${item.urgent ? 'interrupt' : ''}">${escapeHtml(meta)}</span></li>`;
        })
        .join('')
    : '<li class="empty">Policy desk, claim writer, evidence, and sketch artist will show up here as the agent calls them.</li>';
  penEl.hidden = !isWriting();
}

function appendSystem(text: string) {
  localTurns.push({ id: crypto.randomUUID(), speaker: 'System', text });
  render();
}

function applyServerState(next: ClaimState) {
  state = { ...emptyState, ...next };
  // Finalized turns now live in the authoritative transcript.
  const known = new Set(state.transcript.map((turn) => turn.text.trim()));
  pruneCaptions();
  for (let i = localTurns.length - 1; i >= 0; i--) {
    const turn = localTurns[i]!;
    if (turn.speaker === 'Claimant' && known.has(turn.text.trim())) localTurns.splice(i, 1);
  }
  if (state.live_model) {
    modelLabel.textContent = `${state.live_model} · claim team ${state.claim_model} · sketches ${state.sketch_model}`;
    pageAgent.textContent = `${state.live_model}, field notes`;
  }
  if (state.avatar?.enabled) avatarName.textContent = 'Claim assistant · Tavus avatar';
  render();
}

async function readStream(reader: TextStreamReader, onChunk?: (text: string) => void): Promise<string> {
  let text = '';
  for await (const chunk of reader) {
    text += chunk;
    onChunk?.(text);
  }
  return text;
}

function isAgentParticipant(participant?: Participant) {
  return participant?.kind === ParticipantKind.AGENT || participant?.identity === 'tavus-avatar-agent';
}

function attachTrack(track: RemoteTrack, participant: RemoteParticipant) {
  if (track.kind === Track.Kind.Audio) {
    const element = track.attach();
    audioSink.appendChild(element);
    element.play().catch(() => {
      resumeAvatar.hidden = false;
      setAvatarStatus('Tap to hear your assistant', 'paused');
    });
    return;
  }
  if (track.kind === Track.Kind.Video && isAgentParticipant(participant)) {
    track.attach(avatarVideo);
    avatarVideo.hidden = false;
    setAvatarStatus('Live avatar · voice and video', 'speaking');
    avatarVideo.play().catch(() => {
      resumeAvatar.hidden = false;
      setAvatarStatus('Tap to hear and see your assistant', 'paused');
    });
  }
}

function resetMediaUi() {
  micOn = false;
  cameraOn = false;
  micButton.classList.remove('active');
  micButton.querySelector('.round-label')!.textContent = 'Talk';
  cameraButton.classList.remove('active');
  cameraButton.querySelector('.round-label')!.textContent = 'Show camera';
  cameraStage.hidden = true;
  cameraPreview.srcObject = null;
  avatarVideo.hidden = true;
  avatarVideo.srcObject = null;
  audioSink.innerHTML = '';
  resumeAvatar.hidden = true;
}

async function connect(): Promise<Room> {
  if (room) return room;
  if (connecting) return connecting;
  const epoch = generation;
  setStatus('Connecting', 'neutral');
  setAvatarStatus('Connecting your assistant…', 'connecting');
  connecting = (async () => {
    const response = await fetch('/api/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || `Token request failed with status ${response.status}`);
    const next = new Room({ adaptiveStream: true, dynacast: true });

    next.registerTextStreamHandler('claim.state', async (reader) => {
      const text = await readStream(reader);
      if (epoch !== generation) return;
      try {
        applyServerState(JSON.parse(text));
      } catch (error) {
        console.warn('Bad claim state', error);
      }
    });
    next.registerTextStreamHandler('claim.event', async (reader) => {
      const text = await readStream(reader);
      if (epoch !== generation) return;
      const event = JSON.parse(text);
      if (event.type === 'error') appendSystem(event.message);
    });
    next.registerTextStreamHandler('lk.transcription', async (reader, participantInfo) => {
      if (epoch !== generation) return;
      const attributes = reader.info.attributes || {};
      const id = attributes['lk.segment_id'] || reader.info.id;
      const speaker = participantInfo.identity === next.localParticipant.identity ? 'Claimant' : 'Agent';
      const baseline = interimTurns.get(id)?.baseline ?? finalTurnCount(speaker);
      const final = await readStream(reader, (text) => {
        if (epoch !== generation) return;
        interimTurns.set(id, { id, speaker, text, streaming: true, baseline });
        renderTranscript();
      });
      if (epoch !== generation) return;
      const done = attributes['lk.transcription_final'] === 'true';
      if (final.trim()) interimTurns.set(id, { id, speaker, text: final, streaming: !done, baseline });
      else interimTurns.delete(id);
      pruneCaptions();
      renderTranscript();
    });

    next.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => attachTrack(track, participant));
    next.on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach().forEach((element) => {
        if (element !== avatarVideo) element.remove();
      });
      if (track.kind === Track.Kind.Video) avatarVideo.hidden = true;
    });
    next.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      resumeAvatar.hidden = next.canPlaybackAudio;
    });
    next.on(RoomEvent.Disconnected, () => {
      if (room !== next) return;
      room = null;
      connecting = null;
      resetMediaUi();
      setStatus('Disconnected — New intake to start again', 'warning');
      setAvatarStatus('Call ended', 'idle');
    });

    await next.connect(payload.url, payload.token);
    if (epoch !== generation) {
      await next.disconnect();
      throw new Error('Intake was reset.');
    }
    room = next;
    setStatus('Live', '');
    setAvatarStatus(state.avatar?.enabled ? 'Avatar joining…' : 'Voice assistant · listening', 'listening');
    return next;
  })();
  try {
    return await connecting;
  } catch (error) {
    connecting = null;
    setStatus('Connection failed', 'danger');
    setAvatarStatus('Not connected', 'error');
    throw error;
  }
}

async function toggleMic() {
  try {
    const current = await connect();
    await current.startAudio();
    micOn = !micOn;
    await current.localParticipant.setMicrophoneEnabled(micOn, { echoCancellation: true, noiseSuppression: true, autoGainControl: true });
    micButton.classList.toggle('active', micOn);
    micButton.querySelector('.round-label')!.textContent = micOn ? 'Listening' : 'Talk';
    setStatus(micOn ? 'Live, listening' : 'Live, mic muted', micOn ? '' : 'neutral');
  } catch (error) {
    micOn = false;
    const err = error as Error;
    appendSystem(/denied|permission|NotAllowed/i.test(`${err.name} ${err.message}`) ? 'Microphone access was denied. Allow it for this site or type instead.' : `Voice failed: ${err.message}`);
  }
}

async function toggleCamera() {
  try {
    const current = await connect();
    cameraOn = !cameraOn;
    const publication = await current.localParticipant.setCameraEnabled(cameraOn, { facingMode: 'environment', resolution: { width: 640, height: 480 } });
    if (cameraOn && publication?.track) {
      publication.track.attach(cameraPreview);
      cameraStage.hidden = false;
    } else {
      cameraStage.hidden = true;
      cameraPreview.srcObject = null;
    }
    cameraButton.classList.toggle('active', cameraOn);
    cameraButton.querySelector('.round-label')!.textContent = cameraOn ? 'Stop camera' : 'Show camera';
  } catch (error) {
    cameraOn = false;
    cameraStage.hidden = true;
    const err = error as Error;
    appendSystem(/denied|permission|NotAllowed/i.test(`${err.name} ${err.message}`) ? 'Camera access was denied. Allow it for this site to show the damage.' : `Camera failed: ${err.message}`);
  }
}

async function sendTyped(text: string) {
  try {
    const current = await connect();
    await current.startAudio();
    await current.localParticipant.sendText(text, { topic: 'lk.chat' });
    localTurns.push({ id: crypto.randomUUID(), speaker: 'Claimant', text });
    render();
  } catch (error) {
    textInput.value = text;
    appendSystem(`${(error as Error).message} Your message is back in the input; send it again to retry.`);
  }
}

async function newIntake() {
  newIntakeButton.disabled = true;
  generation += 1;
  const current = room;
  room = null;
  connecting = null;
  resetMediaUi();
  if (current) await current.disconnect().catch(() => undefined);
  state = { ...emptyState };
  localTurns.length = 0;
  interimTurns.clear();
  seenNotes.clear();
  pageDate.textContent = `Claim intake notes · ${new Date().toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
  setStatus('Ready', 'neutral');
  setAvatarStatus('Tap Talk to start the call', 'idle');
  render();
  newIntakeButton.disabled = false;
}

function dataUrlBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(',')[1] || '';
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

async function downloadPacket() {
  const zip = new JSZip();
  zip.file('claim.md', state.packet_markdown || emptyState.packet_markdown);
  zip.file('evidence.json', JSON.stringify(state.evidence_manifest || [], null, 2));
  for (const photo of state.evidence_photos || []) zip.file(`evidence/${photo.id}.jpg`, dataUrlBytes(photo.data_url));
  if (state.sketch) zip.file('sketch.svg', dataUrlBytes(state.sketch.data_url));
  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'claim-packet.zip';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

micButton.addEventListener('click', () => void toggleMic());
cameraButton.addEventListener('click', () => void toggleCamera());
newIntakeButton.addEventListener('click', () => void newIntake());
textForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = textInput.value.trim();
  if (!value) return;
  textInput.value = '';
  void sendTyped(value);
});
resumeAvatar.addEventListener('click', () => {
  void room?.startAudio();
  void avatarVideo.play().catch(() => undefined);
  resumeAvatar.hidden = true;
});
$('#openPacket').addEventListener('click', () => packetDialog.showModal());
$('#closePacket').addEventListener('click', () => packetDialog.close());
$('#downloadPacket').addEventListener('click', () => void downloadPacket());
window.addEventListener('pagehide', () => void room?.disconnect());

pageDate.textContent = `Claim intake notes · ${new Date().toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
render();
fetch('/api/health')
  .then((response) => response.json())
  .then((health) => {
    if (health.missing?.length) {
      setStatus('Setup required', 'danger');
      appendSystem(`Missing ${health.missing.join(', ')} in .env. Add them and restart the web server and agent.`);
    }
    modelLabel.textContent = `OpenAI voice · ${health.avatar ? 'Tavus avatar' : 'voice only'}`;
  })
  .catch(() => setStatus('Backend unavailable', 'danger'));
