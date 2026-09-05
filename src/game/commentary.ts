import type { Role, RoleInput, SquadSize } from "./types";

/** The five shipped challenges. Keeping this local makes the commentator pure. */
export const COMMENTARY_CHALLENGE_IDS = [
  "wobble-run",
  "ferry-job",
  "summit-sync",
  "egg-express",
  "slam-dunk",
] as const;

export type CommentaryChallengeId = (typeof COMMENTARY_CHALLENGE_IDS)[number];
export type CommentaryKind = "anticipation" | "failure" | "near-fail" | "coordination" | "recovery" | "completion";
export type CommentaryTone = "bad" | "info" | "good";

export interface CommentaryLine {
  id: string;
  kind: CommentaryKind;
  tone: CommentaryTone;
  text: string;
}

/**
 * A cheap snapshot of facts the game already owns. `timeMs` is simulation/run
 * time, never wall-clock time, so recording and replaying frames is exact.
 */
export interface CommentaryFrame {
  timeMs: number;
  challengeId: CommentaryChallengeId;
  running: boolean;
  finished: boolean;
  squadSize: SquadSize;
  inputs: Partial<Record<Role, RoleInput>>;
  /** Angle from upright, in radians. */
  pelvisTilt: number;
  grounded: boolean;
  fallen: boolean;
  hanging: boolean;
  /** Number of hands currently holding something (0, 1, or 2). */
  holding: number;
  verticalSpeed: number;
  horizontalSpeed: number;
  /** Current brace strength, 0..1. */
  brace: number;
  crouch: boolean;
  /** Current checkpoint index; use -1 before the first checkpoint. */
  checkpoint: number;
  score: number;
  delivery: boolean;
}

export type CommentaryBodyEventType =
  | "step"
  | "land"
  | "grab"
  | "release"
  | "throw"
  | "fall"
  | "getup"
  | "jump"
  | "kick"
  | "shout"
  | "climb";

export interface CommentaryBodyEvent {
  type: CommentaryBodyEventType;
  hand?: 0 | 1;
  propId?: number;
}

export type CommentaryObjectiveEventType =
  | "start"
  | "thud"
  | "bounce"
  | "splash"
  | "crack"
  | "checkpoint"
  | "score"
  | "delivery"
  | "finish";

export interface CommentaryObjectiveEvent {
  type: CommentaryObjectiveEventType;
  force?: number;
  /** New checkpoint/score value, when the event already knows it. */
  value?: number;
  target?: number;
  subject?: "player" | "cargo" | "egg" | "core" | "ball";
}

export type CommentaryAction =
  | { source: "body"; event: CommentaryBodyEvent }
  | { source: "objective"; event: CommentaryObjectiveEvent };

export interface CommentaryOptions {
  /** Stable replay/round seed. Strings are hashed deterministically. */
  seed?: number | string;
  globalCooldownMs?: number;
  categoryCooldownMs?: Partial<Record<CommentaryKind, number>>;
}

interface NormalizedFrame extends Omit<CommentaryFrame, "timeMs" | "pelvisTilt" | "holding" | "verticalSpeed" | "horizontalSpeed" | "brace" | "checkpoint" | "score"> {
  timeMs: number;
  pelvisTilt: number;
  holding: number;
  verticalSpeed: number;
  horizontalSpeed: number;
  brace: number;
  checkpoint: number;
  score: number;
}

interface Candidate {
  kind: CommentaryKind;
  tone: CommentaryTone;
  topic: string;
  variants: readonly string[];
  /** Terminal payoff must not disappear behind a less important line. */
  terminal?: boolean;
}

interface Signals {
  torsoLeanAt: number;
  torsoLeanAxis: "forward" | "back" | "left" | "right" | null;
  torsoLeanAmount: number;
  bothLegsAt: number;
  handsUnstableAt: number;
  legsUnstableAt: number;
}

const DEFAULT_CATEGORY_COOLDOWNS: Record<CommentaryKind, number> = {
  anticipation: 500,
  failure: 900,
  "near-fail": 1_700,
  coordination: 1_900,
  recovery: 1_050,
  completion: 500,
};

const INPUT_DEAD_ZONE = 0.34;
const DANGER_TILT_ENTER = 0.76;
const DANGER_TILT_EXIT = 0.46;
const DANGER_DROP_ENTER = -2.35;
const DANGER_DROP_EXIT = -0.65;
const RECENT_CAUSE_MS = 900;

const emptySignals = (): Signals => ({
  torsoLeanAt: Number.NEGATIVE_INFINITY,
  torsoLeanAxis: null,
  torsoLeanAmount: 0,
  bothLegsAt: Number.NEGATIVE_INFINITY,
  handsUnstableAt: Number.NEGATIVE_INFINITY,
  legsUnstableAt: Number.NEGATIVE_INFINITY,
});

const finite = (value: number | undefined, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const activeAxis = (input: RoleInput | undefined): boolean =>
  Boolean(input && (Math.abs(input.f) > INPUT_DEAD_ZONE || Math.abs(input.s) > INPUT_DEAD_ZONE));

const handAction = (input: RoleInput | undefined): boolean =>
  Boolean(input && (activeAxis(input) || input.a || input.b || input.q || input.e));

const sameBoolean = (left: boolean | undefined, right: boolean | undefined): boolean => Boolean(left) === Boolean(right);

function hashString(value: string): number {
  let hash = 2_166_136_261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function seedNumber(seed: number | string | undefined): number {
  if (typeof seed === "string") return hashString(seed);
  return finite(seed ?? 0x51f15e, 0x51f15e) >>> 0;
}

function mix32(value: number): number {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

function normaliseFrame(frame: CommentaryFrame): NormalizedFrame {
  return {
    ...frame,
    timeMs: Math.max(0, finite(frame.timeMs)),
    pelvisTilt: Math.abs(finite(frame.pelvisTilt)),
    holding: Math.round(clamp(finite(frame.holding), 0, 2)),
    verticalSpeed: finite(frame.verticalSpeed),
    horizontalSpeed: Math.max(0, finite(frame.horizontalSpeed)),
    brace: clamp(finite(frame.brace), 0, 1),
    checkpoint: Math.trunc(finite(frame.checkpoint, -1)),
    score: Math.max(0, Math.trunc(finite(frame.score))),
  };
}

/**
 * Pure, synchronous gameplay commentary. One method call yields at most one
 * line and all causal memory is fixed-size.
 */
export class CommentarySystem {
  private seed: number;
  private readonly initialSeed: number;
  private readonly globalCooldownMs: number;
  private readonly categoryCooldownMs: Record<CommentaryKind, number>;
  private nowMs = 0;
  private sequence = 0;
  private context: NormalizedFrame | null = null;
  private previous: NormalizedFrame | null = null;
  private signals: Signals = emptySignals();
  private topicCounts = new Map<string, number>();
  private lastGlobalAt = Number.NEGATIVE_INFINITY;
  private lastCategoryAt: Record<CommentaryKind, number> = {
    anticipation: Number.NEGATIVE_INFINITY,
    failure: Number.NEGATIVE_INFINITY,
    "near-fail": Number.NEGATIVE_INFINITY,
    coordination: Number.NEGATIVE_INFINITY,
    recovery: Number.NEGATIVE_INFINITY,
    completion: Number.NEGATIVE_INFINITY,
  };
  private lastText = "";
  private dangerLatched = false;
  private dangerStartedAt = Number.NEGATIVE_INFINITY;
  private grabMismatchLatched = false;
  private throwMismatchLatched = false;
  private handMovementMismatchLatched = false;
  private simultaneousLegsLatched = false;
  private unstableHandsLatched = false;
  private unstableLegsLatched = false;
  private lostGripAt = Number.NEGATIVE_INFINITY;
  private lastFallAt = Number.NEGATIVE_INFINITY;
  private announcedCheckpoint = -1;
  private announcedScore = 0;
  private deliveryAnnounced = false;
  private finishAnnounced = false;

  constructor(options: CommentaryOptions = {}) {
    this.seed = seedNumber(options.seed);
    this.initialSeed = this.seed;
    this.globalCooldownMs = Math.max(0, finite(options.globalCooldownMs ?? 650));
    this.categoryCooldownMs = {
      ...DEFAULT_CATEGORY_COOLDOWNS,
      ...options.categoryCooldownMs,
    };
    for (const kind of Object.keys(this.categoryCooldownMs) as CommentaryKind[]) {
      this.categoryCooldownMs[kind] = Math.max(0, finite(this.categoryCooldownMs[kind]));
    }
  }

  /** Restore exact initial replay state. Passing a seed starts a new replay. */
  reset(seed: number | string = this.initialSeed): void {
    this.seed = seedNumber(seed);
    this.nowMs = 0;
    this.sequence = 0;
    this.context = null;
    this.previous = null;
    this.signals = emptySignals();
    this.topicCounts.clear();
    this.clearCooldowns();
    this.lastText = "";
    this.clearTransientState();
    this.announcedCheckpoint = -1;
    this.announcedScore = 0;
    this.deliveryAnnounced = false;
    this.finishAnnounced = false;
  }

  /** Observe a frame and report its highest-value state change, if any. */
  update(frame: CommentaryFrame): CommentaryLine | null {
    const current = this.observe(frame);
    const previous = this.previous;
    let candidate: Candidate | null = null;

    if (!previous) {
      this.announcedCheckpoint = current.checkpoint;
      this.announcedScore = current.score;
      this.deliveryAnnounced = current.delivery;
      this.finishAnnounced = current.finished;
    } else if (current.running || current.finished || previous.running) {
      if (current.finished && !previous.finished && !this.finishAnnounced) {
        this.finishAnnounced = true;
        candidate = this.finishCandidate(current.challengeId);
      } else if (current.fallen && !previous.fallen && this.nowMs - this.lastFallAt > 80) {
        this.lastFallAt = this.nowMs;
        candidate = this.fallCandidate();
      } else if (current.delivery && !previous.delivery && !this.deliveryAnnounced) {
        this.deliveryAnnounced = true;
        candidate = this.deliveryCandidate(current.challengeId);
      } else if (current.score > previous.score && current.score > this.announcedScore) {
        this.announcedScore = current.score;
        candidate = this.scoreCandidate(current.challengeId, current.score);
      } else if (current.checkpoint > previous.checkpoint && current.checkpoint > this.announcedCheckpoint) {
        this.announcedCheckpoint = current.checkpoint;
        candidate = this.checkpointCandidate(current.challengeId, current.checkpoint);
      } else {
        candidate = this.recoveryCandidate(previous, current) ?? this.dangerCandidate(current) ?? this.coordinationCandidate(current);
      }
    }

    this.updateGripState(previous, current);
    this.previous = current;
    return candidate ? this.emit(candidate) : null;
  }

  /** Feed an event from RagdollBody. The most recently observed frame is used. */
  onBodyEvent(event: CommentaryBodyEvent, frame?: CommentaryFrame): CommentaryLine | null {
    if (frame) this.observe(frame);
    const current = this.context;
    if (!current || (!current.running && event.type !== "getup")) return null;

    let candidate: Candidate | null = null;
    switch (event.type) {
      case "fall":
        if (this.nowMs - this.lastFallAt > 80) {
          this.lastFallAt = this.nowMs;
          candidate = this.fallCandidate();
        }
        break;
      case "getup":
        candidate = {
          kind: "recovery",
          tone: "good",
          topic: "body.getup",
          variants: ["Great recovery. Back on your feet.", "Back upright—nice save.", "Gravity filed a complaint. Denied."],
        };
        this.dangerLatched = false;
        break;
      case "grab":
        if (this.nowMs - this.lostGripAt <= 2_000) {
          candidate = {
            kind: "recovery",
            tone: "good",
            topic: "body.regrab",
            variants: ["Regrab secured. Keep it steady.", "Grip recovered—carry on.", "Caught it on the sequel."],
          };
          this.lostGripAt = Number.NEGATIVE_INFINITY;
        }
        break;
      case "release":
        if (current.holding > 0 || current.hanging) this.lostGripAt = this.nowMs;
        break;
      case "land":
        if (current.pelvisTilt < DANGER_TILT_EXIT && current.verticalSpeed > DANGER_DROP_EXIT && this.dangerLatched) {
          candidate = this.stabilisedCandidate("landing");
          this.dangerLatched = false;
        }
        break;
      case "climb":
        candidate = {
          kind: "recovery",
          tone: "good",
          topic: "body.climb",
          variants: ["Ledge cleared. Clean recovery.", "Up and over—nice coordination.", "The ledge has been negotiated with."],
        };
        this.dangerLatched = false;
        break;
      default:
        break;
    }
    return candidate ? this.emit(candidate) : null;
  }

  /** Feed an objective/level event (splash, checkpoint, score, and so on). */
  onObjectiveEvent(event: CommentaryObjectiveEvent, frame?: CommentaryFrame): CommentaryLine | null {
    if (frame) this.observe(frame);
    const current = this.context;
    if (!current) return null;

    let candidate: Candidate | null = null;
    switch (event.type) {
      case "start":
        candidate = this.startCandidate(current.challengeId);
        break;
      case "splash":
        candidate = this.splashCandidate(current.challengeId, event.subject);
        break;
      case "crack":
        candidate = {
          kind: "failure",
          tone: "bad",
          topic: "egg-express.crack",
          variants: [
            "The egg cracked—gentler hands next carry.",
            "Too much impact for the egg. Reset and soften the landing.",
            "That egg is now emotionally scrambled.",
          ],
        };
        break;
      case "checkpoint": {
        const inferred = event.value === undefined ? this.announcedCheckpoint + 1 : event.value;
        const value = Math.max(current.checkpoint, Math.trunc(finite(inferred, current.checkpoint)));
        if (value > this.announcedCheckpoint) {
          this.announcedCheckpoint = value;
          candidate = this.checkpointCandidate(current.challengeId, value);
        }
        break;
      }
      case "score": {
        const inferred = event.value === undefined ? this.announcedScore + 1 : event.value;
        const value = Math.max(current.score, Math.trunc(finite(inferred, current.score)));
        if (value > this.announcedScore || current.challengeId === "summit-sync" && !this.deliveryAnnounced) {
          this.announcedScore = value;
          if (current.challengeId === "summit-sync") this.deliveryAnnounced = true;
          candidate = this.scoreCandidate(current.challengeId, value, event.target);
        }
        break;
      }
      case "delivery":
        if (!this.deliveryAnnounced) {
          this.deliveryAnnounced = true;
          candidate = this.deliveryCandidate(current.challengeId);
        }
        break;
      case "finish":
        if (!this.finishAnnounced) {
          this.finishAnnounced = true;
          candidate = this.finishCandidate(current.challengeId);
        }
        break;
      case "thud":
        if ((event.force ?? 0) >= 0.68) {
          candidate = {
            kind: "near-fail",
            tone: "info",
            topic: `${current.challengeId}.hard-impact`,
            variants: ["Hard impact. Settle the body before the next move.", "That landing nearly got away—stabilize first."],
          };
        }
        break;
      case "bounce":
        if ((event.force ?? 0) >= 0.58 && current.holding > 0) {
          candidate = {
            kind: "near-fail",
            tone: "info",
            topic: `${current.challengeId}.cargo-bounce`,
            variants: ["The cargo bounced—settle it before moving.", "Wobbly cargo. Give it one beat."],
          };
        }
        break;
    }
    return candidate ? this.emit(candidate) : null;
  }

  /** Generic action API for callers that keep body and level events together. */
  handle(action: CommentaryAction, frame?: CommentaryFrame): CommentaryLine | null {
    return action.source === "body"
      ? this.onBodyEvent(action.event, frame)
      : this.onObjectiveEvent(action.event, frame);
  }

  private observe(frame: CommentaryFrame): NormalizedFrame {
    const next = normaliseFrame(frame);
    const challengeChanged = Boolean(this.context && this.context.challengeId !== next.challengeId);
    const clockRewound = Boolean(this.context && next.timeMs < this.context.timeMs);
    if (challengeChanged || clockRewound) {
      this.previous = null;
      this.signals = emptySignals();
      this.clearTransientState();
      this.clearCooldowns();
      this.lastText = "";
      this.announcedCheckpoint = -1;
      this.announcedScore = 0;
      this.deliveryAnnounced = false;
      this.finishAnnounced = false;
    }
    this.context = next;
    this.nowMs = next.timeMs;
    this.recordSignals(next);
    return next;
  }

  private recordSignals(frame: NormalizedFrame): void {
    const torso = frame.inputs.torso;
    if (torso) {
      const forwardAmount = Math.abs(torso.f);
      const sideAmount = Math.abs(torso.s);
      const amount = Math.max(forwardAmount, sideAmount);
      if (amount >= 0.62) {
        this.signals.torsoLeanAt = this.nowMs;
        this.signals.torsoLeanAmount = amount;
        this.signals.torsoLeanAxis = forwardAmount >= sideAmount
          ? torso.f >= 0 ? "forward" : "back"
          : torso.s >= 0 ? "right" : "left";
      }
    }

    const unstable = frame.pelvisTilt >= 0.54 || !frame.grounded;
    const leftHand = frame.inputs.lhand;
    const rightHand = frame.inputs.rhand;
    const handsMoving = frame.squadSize === 3
      ? handAction(frame.inputs.arms)
      : handAction(leftHand) || handAction(rightHand);
    if (handsMoving && unstable) this.signals.handsUnstableAt = this.nowMs;

    if (frame.squadSize === 3 && activeAxis(frame.inputs.legs) && unstable) {
      this.signals.legsUnstableAt = this.nowMs;
    }
    if (frame.squadSize === 5 && activeAxis(frame.inputs.lleg) && activeAxis(frame.inputs.rleg)) {
      this.signals.bothLegsAt = this.nowMs;
    }
  }

  private fallCandidate(): Candidate {
    const axis = this.signals.torsoLeanAxis;
    if (axis && this.nowMs - this.signals.torsoLeanAt <= RECENT_CAUSE_MS && this.signals.torsoLeanAmount >= 0.74) {
      const label = axis === "back" ? "backward" : axis;
      return {
        kind: "failure",
        tone: "bad",
        topic: `fall.torso-${axis}`,
        variants: [
          `You fell because the torso leaned too far ${label}.`,
          `Too much ${label} lean tipped the body over.`,
          `The torso outran the feet on that ${label} lean.`,
        ],
      };
    }
    if (this.nowMs - this.signals.bothLegsAt <= RECENT_CAUSE_MS) {
      return {
        kind: "failure",
        tone: "bad",
        topic: "fall.simultaneous-legs",
        variants: [
          "Both legs moved together, so the body lost its base.",
          "The legs stepped at once; alternate to keep a base.",
          "Both legs voted ‘now.’ Gravity agreed.",
        ],
      };
    }
    if (this.nowMs - this.signals.handsUnstableAt <= RECENT_CAUSE_MS) {
      return {
        kind: "failure",
        tone: "bad",
        topic: "fall.hands-before-balance",
        variants: [
          "The hands moved before the body was stable.",
          "The body was still wobbling when the hands moved.",
          "Hands went early; balance never caught up.",
        ],
      };
    }
    if (this.nowMs - this.signals.legsUnstableAt <= RECENT_CAUSE_MS) {
      return {
        kind: "failure",
        tone: "bad",
        topic: "fall.legs-before-balance",
        variants: ["The legs moved before the torso had settled.", "That step arrived before balance did."],
      };
    }
    if ((this.context?.horizontalSpeed ?? 0) > 4.2) {
      return {
        kind: "failure",
        tone: "bad",
        topic: "fall.speed",
        variants: ["Too much sideways speed carried the body over.", "Momentum won that argument. Slow the setup."],
      };
    }
    return {
      kind: "failure",
      tone: "bad",
      topic: "fall.balance",
      variants: ["The body went past its balance point.", "The base slipped outside the body—reset and brace."],
    };
  }

  private dangerCandidate(frame: NormalizedFrame): Candidate | null {
    if (frame.fallen) return null;
    const entering = frame.pelvisTilt >= DANGER_TILT_ENTER
      || (!frame.grounded && !frame.hanging && frame.verticalSpeed <= DANGER_DROP_ENTER);
    const exiting = frame.pelvisTilt <= DANGER_TILT_EXIT
      && (frame.grounded || frame.hanging)
      && frame.verticalSpeed >= DANGER_DROP_EXIT;

    if (!this.dangerLatched && entering) {
      this.dangerLatched = true;
      this.dangerStartedAt = this.nowMs;
      if (!frame.grounded && frame.verticalSpeed <= DANGER_DROP_ENTER) {
        return {
          kind: "near-fail",
          tone: "info",
          topic: "danger.drop",
          variants: ["Fast drop—find a handhold or prepare the landing.", "Ground is arriving quickly. Brace the landing."],
        };
      }
      const torso = frame.inputs.torso;
      const direction = torso && Math.max(Math.abs(torso.f), Math.abs(torso.s)) > 0.45
        ? Math.abs(torso.f) >= Math.abs(torso.s)
          ? torso.f >= 0 ? "forward" : "back"
          : torso.s >= 0 ? "right" : "left"
        : null;
      const crouchedCarry = frame.crouch && frame.holding > 0;
      return {
        kind: "near-fail",
        tone: "info",
        topic: `danger.tilt-${direction ?? "unknown"}`,
        variants: crouchedCarry
          ? ["Crouch is set; now let the loaded torso settle.", "Keep the cargo low and ease the lean back."]
          : direction
          ? [`Heavy ${direction} lean—brace or ease the torso back.`, `Balance is going ${direction}. Give the feet a beat.`]
          : ["Balance is on the edge—brace and let it settle.", "That wobble is one move from a fall."],
      };
    }
    if (this.dangerLatched && exiting) {
      this.dangerLatched = false;
      if (this.nowMs - this.dangerStartedAt >= 120) return this.stabilisedCandidate("wobble");
    }
    return null;
  }

  private recoveryCandidate(previous: NormalizedFrame, current: NormalizedFrame): Candidate | null {
    if (previous.fallen && !current.fallen) {
      this.dangerLatched = false;
      return {
        kind: "recovery",
        tone: "good",
        topic: "state.getup",
        variants: ["Great recovery. Back on your feet.", "Back upright—nice save.", "Gravity filed a complaint. Denied."],
      };
    }
    if (previous.hanging && !current.hanging && current.grounded && !current.fallen) {
      this.dangerLatched = false;
      return {
        kind: "recovery",
        tone: "good",
        topic: "state.mantle",
        variants: ["Clutch pull-up. You found solid ground.", "Hanging to standing—great recovery."],
      };
    }
    if (current.holding > previous.holding && this.nowMs - this.lostGripAt <= 2_000) {
      this.lostGripAt = Number.NEGATIVE_INFINITY;
      return {
        kind: "recovery",
        tone: "good",
        topic: "state.regrab",
        variants: ["Regrab secured. Keep it steady.", "Grip recovered—carry on.", "Caught it on the sequel."],
      };
    }
    if (this.dangerLatched
      && previous.brace < 0.55
      && current.brace >= 0.55
      && current.pelvisTilt <= previous.pelvisTilt - 0.08) {
      this.dangerLatched = false;
      return this.stabilisedCandidate("brace");
    }
    return null;
  }

  private coordinationCandidate(frame: NormalizedFrame): Candidate | null {
    const unstable = frame.pelvisTilt >= 0.54 || !frame.grounded;
    if (frame.squadSize === 5) {
      const leftHand = frame.inputs.lhand;
      const rightHand = frame.inputs.rhand;
      const grabMismatch = !sameBoolean(leftHand?.a, rightHand?.a);
      const throwMismatch = frame.holding > 0 && !sameBoolean(leftHand?.b, rightHand?.b);
      const handDelta = Math.abs((leftHand?.f ?? 0) - (rightHand?.f ?? 0))
        + Math.abs((leftHand?.s ?? 0) - (rightHand?.s ?? 0));
      const handMovementMismatch = handDelta > 0.8 && (activeAxis(leftHand) || activeAxis(rightHand));
      const simultaneousLegs = activeAxis(frame.inputs.lleg) && activeAxis(frame.inputs.rleg);
      const unstableHands = unstable && (handAction(leftHand) || handAction(rightHand));

      let candidate: Candidate | null = null;
      if (grabMismatch && !this.grabMismatchLatched) {
        candidate = {
          kind: "coordination",
          tone: "info",
          topic: "coord.split-grab",
          variants: ["Both hands need Space together for a two-hand grab.", "One hand called grab; the other missed the meeting."],
        };
      } else if (throwMismatch && !this.throwMismatchLatched) {
        candidate = {
          kind: "coordination",
          tone: "info",
          topic: "coord.split-throw",
          variants: ["Both hands need Shift together to throw.", "The throw needs two yes votes from the hands."],
        };
      } else if (handMovementMismatch && !this.handMovementMismatchLatched) {
        candidate = {
          kind: "coordination",
          tone: "info",
          topic: "coord.split-hand-move",
          variants: ["The hands split directions—match the swing first.", "Left and right hands are steering different plans."],
        };
      } else if (simultaneousLegs && !this.simultaneousLegsLatched) {
        candidate = {
          kind: "coordination",
          tone: "info",
          topic: "coord.simultaneous-legs",
          variants: ["Both legs moved together; alternate the steps.", "One leg, then the other. The floor appreciates rhythm."],
        };
      } else if (unstableHands && !this.unstableHandsLatched) {
        candidate = {
          kind: "coordination",
          tone: "info",
          topic: "coord.hands-before-balance",
          variants: ["The hands moved before the body was stable.", "Let the torso settle, then move the hands."],
        };
      }
      this.grabMismatchLatched = grabMismatch;
      this.throwMismatchLatched = throwMismatch;
      this.handMovementMismatchLatched = handMovementMismatch;
      this.simultaneousLegsLatched = simultaneousLegs;
      this.unstableHandsLatched = unstableHands;
      return candidate;
    }

    const armsUnstable = unstable && handAction(frame.inputs.arms);
    const legsUnstable = unstable && activeAxis(frame.inputs.legs);
    let candidate: Candidate | null = null;
    if (armsUnstable && !this.unstableHandsLatched) {
      candidate = {
        kind: "coordination",
        tone: "info",
        topic: "coord.arms-before-balance",
        variants: ["The hands moved before the body was stable.", "Let the torso settle, then move the arms."],
      };
    } else if (legsUnstable && !this.unstableLegsLatched) {
      candidate = {
        kind: "coordination",
        tone: "info",
        topic: "coord.legs-before-balance",
        variants: ["The legs moved before the torso was stable.", "Give the torso one beat, then step."],
      };
    }
    this.unstableHandsLatched = armsUnstable;
    this.unstableLegsLatched = legsUnstable;
    return candidate;
  }

  private updateGripState(previous: NormalizedFrame | null, current: NormalizedFrame): void {
    if (!previous) return;
    if ((previous.holding > current.holding || previous.hanging && !current.hanging) && !current.fallen) {
      this.lostGripAt = this.nowMs;
    }
  }

  private stabilisedCandidate(source: "wobble" | "landing" | "brace"): Candidate {
    return {
      kind: "recovery",
      tone: "good",
      topic: `recovery.${source}`,
      variants: source === "landing"
        ? ["Landing held. Great recovery.", "That landing wobbled, then stuck."]
        : source === "brace"
          ? ["Brace caught the wobble. Great recovery.", "Clutch brace—the body is back under control."]
        : ["Great recovery. The wobble is under control.", "Clutch stabilization—now move.", "Chaos contained. Mostly."],
    };
  }

  private checkpointCandidate(challenge: CommentaryChallengeId, checkpoint: number): Candidate {
    const number = checkpoint + 1;
    const variants: Record<CommentaryChallengeId, readonly string[]> = {
      "wobble-run": [`Checkpoint ${number}. The bridge is behind you.`, `Checkpoint ${number} locked. Keep the rhythm.`],
      "ferry-job": [`Checkpoint ${number}. Cargo route secured.`, `Checkpoint ${number} locked—steady on the ferries.`],
      "summit-sync": [`Summit checkpoint ${number}. Higher and harder.`, `Checkpoint ${number}. The peak is listening.`],
      "egg-express": [`Checkpoint ${number}. The egg still has a future.`, `Checkpoint ${number}. Shell status: heroic.`],
      "slam-dunk": [`Checkpoint ${number}.`, `Progress saved at checkpoint ${number}.`],
    };
    return { kind: "completion", tone: "good", topic: `${challenge}.checkpoint`, variants: variants[challenge] };
  }

  private startCandidate(challenge: CommentaryChallengeId): Candidate {
    const variants: Record<CommentaryChallengeId, readonly string[]> = {
      "wobble-run": ["Hurdles first, bridge later. Keep the torso over the feet.", "Find the walking rhythm before the bridge finds you."],
      "ferry-job": ["Cargo, low bar, moving ferries. Same beat, everyone.", "Secure the cargo, then let the ferries come to you."],
      "summit-sync": ["Climb, carry, then beat the gate. Breathe while you can.", "The summit wants one clean chain of teamwork."],
      "egg-express": ["That egg has one health point. Gentle hands.", "Soft grab, steady carry, intact breakfast."],
      "slam-dunk": ["Three baskets. Agree on the grab before the throw.", "Set the feet, match the hands, then launch."],
    };
    return { kind: "anticipation", tone: "info", topic: `${challenge}.start`, variants: variants[challenge] };
  }

  private scoreCandidate(challenge: CommentaryChallengeId, score: number, target = 3): Candidate {
    if (challenge === "slam-dunk") {
      return {
        kind: "completion",
        tone: "good",
        topic: "slam-dunk.score",
        variants: [`Basket ${score}/${target}. Nice release.`, `Score ${score}/${target}. Keep that timing.`, `${score}/${target}. The hoop approves.`],
      };
    }
    if (challenge === "summit-sync") {
      return {
        kind: "completion",
        tone: "good",
        topic: "summit-sync.core",
        variants: ["Core placed. Now sprint the timing gate.", "Core is stable—gate run starts now."],
      };
    }
    return this.deliveryCandidate(challenge);
  }

  private deliveryCandidate(challenge: CommentaryChallengeId): Candidate {
    const variants: Record<CommentaryChallengeId, readonly string[]> = {
      "wobble-run": ["Objective delivered. Nicely coordinated."],
      "ferry-job": ["Cargo delivered. Ferry crew: surprisingly professional.", "Cargo is down safe. Excellent teamwork."],
      "summit-sync": ["Core placed. Now sprint the timing gate.", "Core stable. The gate is the final push."],
      "egg-express": ["Egg delivered intact. Breakfast remains optional.", "Safe delivery. Not a crack in sight."],
      "slam-dunk": ["Ball delivered. Now finish the set."],
    };
    return { kind: "completion", tone: "good", topic: `${challenge}.delivery`, variants: variants[challenge] };
  }

  private finishCandidate(challenge: CommentaryChallengeId): Candidate {
    const variants: Record<CommentaryChallengeId, readonly string[]> = {
      "wobble-run": ["Finish gate cleared. That chaos had rhythm.", "Wobble Run complete—clutch all the way."],
      "ferry-job": ["Cargo delivered. Shift complete.", "Ferry Job complete—nothing important went swimming."],
      "summit-sync": ["Core placed, gate beaten. Summit complete.", "Summit Sync complete. That final push was clutch."],
      "egg-express": ["Egg delivered intact. Flawless-ish.", "Egg Express complete. The shell survives."],
      "slam-dunk": ["Three baskets. Game, set, wobble.", "Slam Dunk complete. Coordination found the hoop."],
    };
    return {
      kind: "completion",
      tone: "good",
      topic: `${challenge}.finish`,
      variants: variants[challenge],
      terminal: true,
    };
  }

  private splashCandidate(challenge: CommentaryChallengeId, subject?: CommentaryObjectiveEvent["subject"]): Candidate {
    const variants: Record<CommentaryChallengeId, readonly string[]> = {
      "wobble-run": ["Splash. The bridge wins this round.", "Water reset—line up the next crossing."],
      "ferry-job": subject === "cargo"
        ? ["Cargo overboard. Reset and sync the handoff.", "The cargo took the express ferry downward."]
        : ["Ferry missed. Reset and time the next step.", "Unscheduled swim. The dock is ready again."],
      "summit-sync": subject === "core"
        ? ["Core dropped. Rebuild the carry rhythm.", "The summit rejected that delivery route."]
        : ["The canyon collected that attempt. Reset.", "Long way down; short retry."],
      "egg-express": ["Egg overboard. Reset with softer hands.", "The egg found water. It was not part of the recipe."],
      "slam-dunk": ["Ball out of bounds. Set up the next throw.", "That ball chose swimming over scoring."],
    };
    return { kind: "failure", tone: "bad", topic: `${challenge}.splash`, variants: variants[challenge] };
  }

  private emit(candidate: Candidate): CommentaryLine | null {
    if (!candidate.terminal) {
      if (this.nowMs - this.lastGlobalAt < this.globalCooldownMs) return null;
      if (this.nowMs - this.lastCategoryAt[candidate.kind] < this.categoryCooldownMs[candidate.kind]) return null;
    }
    if (candidate.variants.length === 0) return null;

    const topicCount = this.topicCounts.get(candidate.topic) ?? 0;
    const stable = mix32(this.seed ^ hashString(candidate.topic) ^ Math.imul(topicCount + 1, 0x9e3779b1));
    let index = stable % candidate.variants.length;
    if (candidate.variants[index] === this.lastText && candidate.variants.length > 1) {
      index = (index + 1) % candidate.variants.length;
    }
    const text = candidate.variants[index];
    if (text === this.lastText) return null;

    this.sequence += 1;
    this.topicCounts.set(candidate.topic, topicCount + 1);
    this.lastText = text;
    this.lastGlobalAt = this.nowMs;
    this.lastCategoryAt[candidate.kind] = this.nowMs;
    return {
      id: `commentary-${this.seed.toString(36)}-${this.sequence.toString(36)}-${hashString(candidate.topic).toString(36)}`,
      kind: candidate.kind,
      tone: candidate.tone,
      text,
    };
  }

  private clearCooldowns(): void {
    this.lastGlobalAt = Number.NEGATIVE_INFINITY;
    for (const kind of Object.keys(this.lastCategoryAt) as CommentaryKind[]) {
      this.lastCategoryAt[kind] = Number.NEGATIVE_INFINITY;
    }
  }

  private clearTransientState(): void {
    this.dangerLatched = false;
    this.dangerStartedAt = Number.NEGATIVE_INFINITY;
    this.grabMismatchLatched = false;
    this.throwMismatchLatched = false;
    this.handMovementMismatchLatched = false;
    this.simultaneousLegsLatched = false;
    this.unstableHandsLatched = false;
    this.unstableLegsLatched = false;
    this.lostGripAt = Number.NEGATIVE_INFINITY;
    this.lastFallAt = Number.NEGATIVE_INFINITY;
  }
}

export const createCommentarySystem = (options?: CommentaryOptions): CommentarySystem => new CommentarySystem(options);
