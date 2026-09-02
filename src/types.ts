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
