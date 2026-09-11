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

export type GoalStatus = 'backlog' | 'active' | 'completed' | 'archived';

export interface Goal {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  is_quest: boolean;
  status: GoalStatus;
  /** `YYYY-MM-DD`; a calendar date, deliberately not a timestamp. */
  due_date: string | null;
  base_xp: number;
  parent_goal_id: string | null;
  display_order: number;
  virtue_ids: string[];
  completed_at: string | null;
  created_at: string;
}

export interface GoalCreateInput {
  title: string;
  description?: string;
  is_quest?: boolean;
  status?: GoalStatus;
  due_date?: string;
  base_xp?: number;
  parent_goal_id?: string;
  virtue_ids?: string[];
}

export interface GoalListQuery {
  status?: GoalStatus;
  isQuest?: boolean;
  /** Absent means top-level goals only, not "any parent" (api-spec.yml). */
  parentGoalId?: string;
}

/** Partial update; a field's absence (as opposed to `null`, where the schema allows it) leaves it unchanged. */
export interface GoalUpdateInput {
  title?: string;
  description?: string;
  is_quest?: boolean;
  status?: GoalStatus;
  due_date?: string | null;
  display_order?: number;
  virtue_ids?: string[];
}

export type BacklogSource = 'manual' | 'ai_suggestion' | 'field_log';

export interface BacklogItem {
  id: string;
  user_id: string;
  title: string;
  notes: string | null;
  source: BacklogSource;
  source_id: string | null;
  virtue_id: string | null;
  promoted_to_goal_id: string | null;
  created_at: string;
}

export interface BacklogItemCreateInput {
  title: string;
  notes?: string;
  source?: BacklogSource;
  source_id?: string;
  virtue_id?: string;
}

/** Partial update; a field's absence (as opposed to `null`, where the schema allows it) leaves it unchanged. */
export interface BacklogItemUpdateInput {
  title?: string;
  notes?: string | null;
  virtue_id?: string | null;
}

/** Overrides applied to the goal a backlog item is promoted into. */
export interface BacklogPromoteInput {
  is_quest?: boolean;
  due_date?: string;
  base_xp?: number;
}
