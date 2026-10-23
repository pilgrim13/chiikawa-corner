export type CharacterId = 'chiikawa' | 'hachiware' | 'usagi' | 'momonga' | 'kurimanju' | 'shisa' | 'rakko' | 'furuhonya';
export type Member = { id: string; nickname: string; character: CharacterId; color: string; online: boolean; joinedAt: number; lastChatAt?: number; hasChatted?: boolean };
export type ChatMessage = { id: string; memberId: string; nickname: string; character: CharacterId; text: string; sentAt: number; kind?: 'chat' | 'system' };
export type JoinRequest = { id: string; nickname: string; character: CharacterId; requestedAt: number };
export type RoomSnapshot = { id: string; code: string; name: string; hostId: string; locked: boolean; members: Member[]; messages: ChatMessage[]; pending: JoinRequest[] };
export type Session = { memberId: string; token: string; roomId: string };
export type Ack<T = Record<string, never>> = { ok: true; data: T } | { ok: false; error: string; code?: string };
export type Profile = { nickname: string; character: CharacterId };
export type OverlayState = { room: RoomSnapshot | null; memberId: string | null; size: number; quiet: boolean };
export type UpdateState = {
  phase: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'verifying' | 'ready' | 'installing' | 'error' | 'unsupported';
  currentVersion: string;
  latestVersion?: string;
  progress?: number;
  releaseNotes?: string;
  message?: string;
};
export type DesktopApi = {
  getConfig(): Promise<{ serverUrl: string; version: string; isDesktop: boolean; platform: string }>;
  setOverlay(state: OverlayState): void;
  onOverlay(callback: (state: OverlayState) => void): () => void;
  setMousePassthrough(ignore: boolean): void;
  openPanel(): void;
  hidePanel(): void;
  toggleOverlay(): Promise<boolean>;
  copyText(text: string): Promise<void>;
  getDisplays(): Promise<{id: number; label: string}[]>;
  selectDisplay(id: number): Promise<void>;
  getUpdateState(): Promise<UpdateState>;
  onUpdateState(callback: (state: UpdateState) => void): () => void;
  checkForUpdate(): Promise<UpdateState>;
  downloadUpdate(): Promise<UpdateState>;
  installUpdate(): Promise<UpdateState>;
};
declare global { interface Window { corner?: DesktopApi } }
