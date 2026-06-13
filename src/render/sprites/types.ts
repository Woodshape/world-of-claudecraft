export interface SpriteStateDef {
  /** First direction row for this state (subsequent rows are +1 per direction). */
  row: number;
  frames: number;
  fps: number;
  /** Play once then hold last frame (attack/hit/death). */
  once?: boolean;
}

export interface SpriteManifest {
  key: string;
  url: string;
  dirs: number;
  frameSize: [number, number];
  /** Foot anchor in pixel coordinates within each frame. */
  anchor: [number, number];
  worldHeight: number;
  states: Record<string, SpriteStateDef>;
}

export type SpriteAnimState =
  | 'idle'
  | 'walk'
  | 'run'
  | 'walkBack'
  | 'attack'
  | 'hit'
  | 'cast'
  | 'death'
  | 'swim'
  | 'sit';
