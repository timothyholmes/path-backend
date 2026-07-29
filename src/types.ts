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
