export type WorkoutType =
  | 'easy'
  | 'recovery'
  | 'long'
  | 'tempo'
  | 'threshold'
  | 'intervals'
  | 'progression'
  | 'rest'
  | 'race';

export type PlanStatus = 'planned' | 'completed' | 'skipped';

export interface Activity {
  id: string;
  garmin_activity_id: number | null;
  start_time: string;
  name: string | null;
  distance_m: number;
  duration_s: number;
  avg_pace_sec_per_km: number | null;
  gap_sec_per_km: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  elevation_gain_m: number | null;
  training_load: number | null;
}

export interface CoachingPlan {
  id: string;
  plan_date: string; // YYYY-MM-DD
  workout_type: WorkoutType;
  title: string;
  description: string | null;
  duration_min: number | null;
  distance_km: number | null;
  target_pace_fast_sec_km: number | null;
  target_pace_slow_sec_km: number | null;
  hr_zone: number | null;
  rationale: string;
  adaptation_note: string | null;
  adjustment_sec: number;
  status: PlanStatus;
}

export interface CoachAssessment {
  id: string;
  assessed_at: string;
  fatigue_level: 'low' | 'moderate' | 'high';
  readiness_score: number;
  marathon_shape_pct: number | null;
  acwr: number | null;
  summary: string;
  vdot?: number | null;
  vdot_source?: string | null;
  training_paces?: Record<'recovery' | 'easy' | 'marathon' | 'threshold' | 'interval' | 'repetition', { fast: number; slow: number }> | null;
  race_predictions?: { name: string; distance_km: number; predicted_s: number; target_s: number | null }[] | null;
  phase?: string | null;
  weekly_km_target?: number | null;
}

export interface Race {
  id: string;
  name: string;
  race_date: string;
  distance_km: number;
  target_time_s: number | null;
  priority: 'A' | 'B' | 'C';
}

export interface Profile {
  id: string;
  display_name: string | null;
  hr_max: number;
  hr_rest: number;
  weekly_km_target: number | null;
  garmin_connected: boolean;
  garmin_last_sync_at: string | null;
  garmin_last_sync_status: string | null;
}
