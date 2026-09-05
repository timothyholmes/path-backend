export interface ReservationInput {
  owner: string;
  room: string;
  startTime: number;
  endTime: number;
}

export interface Reservation extends ReservationInput {
  reservationId: string;
}

export interface ReservationQuery {
  startTime?: number;
  endTime?: number;
  owner?: string;
  room?: string;
}

export interface Pagination {
  cursor: string | null;
  limit: number;
}

export interface SearchResponse<T> {
  nextCursor?: string | null;
  cursor?: string | null;
  items: Array<T>;
}

export interface AvailabilityQuery {
  startTime: number;
  endTime: number;
}

export interface Availability {
  room: string;
}

export type RoutineFrequency = 'daily' | 'weekly' | 'monthly';

export interface Routine {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  frequency: RoutineFrequency;
  scheduled_day: number | null;
  base_xp: number;
  is_active: boolean;
  virtue_ids: string[];
  created_at: string;
}

export interface RoutineCreateInput {
  title: string;
  description?: string;
  frequency: RoutineFrequency;
  scheduled_day?: number;
  base_xp?: number;
  virtue_ids: string[];
}

export interface RoutineListQuery {
  isActive?: boolean;
  frequency?: RoutineFrequency;
}

/** Partial update; a field's absence (as opposed to `null`, where the schema allows it) leaves it unchanged. */
export interface RoutineUpdateInput {
  title?: string;
  description?: string | null;
  frequency?: RoutineFrequency;
  scheduled_day?: number | null;
  base_xp?: number;
  is_active?: boolean;
  virtue_ids?: string[];
}

export interface ScoringResult {
  xp_earned: number;
  base_xp: number;
  streak_multiplier: number;
  virtue_bonus: number;
  per_virtue_xp: number;
  global_xp: number;
  global_level: number;
  current_streak: number;
  ledger_entry_ids: string[];
}

export type SessionInstanceStatus = 'scheduled' | 'in_progress' | 'completed' | 'skipped';

export interface Session {
  id: string;
  user_id: string;
  title: string;
  target_duration_minutes: number;
  recurrence_rule: Record<string, unknown> | null;
  base_xp: number;
  is_active: boolean;
  virtue_ids: string[];
  created_at: string;
}

export interface SessionCreateInput {
  title: string;
  target_duration_minutes: number;
  recurrence_rule?: Record<string, unknown>;
  base_xp?: number;
  virtue_ids: string[];
}

export interface SessionListQuery {
  isActive?: boolean;
}

/** Partial update; a field's absence (as opposed to `null`, where the schema allows it) leaves it unchanged. */
export interface SessionUpdateInput {
  title?: string;
  target_duration_minutes?: number;
  recurrence_rule?: Record<string, unknown> | null;
  base_xp?: number;
  is_active?: boolean;
  virtue_ids?: string[];
}

export interface SessionInstance {
  id: string;
  session_id: string;
  user_id: string;
  scheduled_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  actual_duration_seconds: number | null;
  status: SessionInstanceStatus;
  xp_earned: number | null;
  skip_penalty_xp: number | null;
  focus_mode_activated: boolean;
}

/** What the client needs to render the fullscreen timer for a started instance. */
export interface TimerState {
  instance: SessionInstance;
  server_time: string;
  target_duration_seconds: number;
}
