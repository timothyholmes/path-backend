export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      daily_activity: {
        Row: {
          activity_date: string
          completion_count: number
          user_id: string
          xp_earned: number
        }
        Insert: {
          activity_date: string
          completion_count?: number
          user_id: string
          xp_earned?: number
        }
        Update: {
          activity_date?: string
          completion_count?: number
          user_id?: string
          xp_earned?: number
        }
        Relationships: [
          {
            foreignKeyName: "daily_activity_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      field_log_templates: {
        Row: {
          ai_prompt_template: string | null
          created_at: string
          creates_followup: boolean
          id: string
          is_active: boolean
          name: string
          prefix: string | null
          schema: Json
          user_id: string
        }
        Insert: {
          ai_prompt_template?: string | null
          created_at?: string
          creates_followup?: boolean
          id?: string
          is_active?: boolean
          name: string
          prefix?: string | null
          schema: Json
          user_id: string
        }
        Update: {
          ai_prompt_template?: string | null
          created_at?: string
          creates_followup?: boolean
          id?: string
          is_active?: boolean
          name?: string
          prefix?: string | null
          schema?: Json
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "field_log_templates_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      field_log_virtues: {
        Row: {
          field_log_id: string
          user_id: string
          virtue_id: string
        }
        Insert: {
          field_log_id: string
          user_id: string
          virtue_id: string
        }
        Update: {
          field_log_id?: string
          user_id?: string
          virtue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "field_log_virtues_field_log_id_user_id_fkey"
            columns: ["field_log_id", "user_id"]
            isOneToOne: false
            referencedRelation: "field_logs"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "field_log_virtues_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "field_log_virtues_virtue_id_user_id_fkey"
            columns: ["virtue_id", "user_id"]
            isOneToOne: false
            referencedRelation: "virtues"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      field_logs: {
        Row: {
          ai_analysis: string | null
          content: Json
          created_at: string
          followup_reminder_at: string | null
          followup_task_id: string | null
          id: string
          prefix: string | null
          template_id: string | null
          user_id: string
        }
        Insert: {
          ai_analysis?: string | null
          content: Json
          created_at?: string
          followup_reminder_at?: string | null
          followup_task_id?: string | null
          id?: string
          prefix?: string | null
          template_id?: string | null
          user_id: string
        }
        Update: {
          ai_analysis?: string | null
          content?: Json
          created_at?: string
          followup_reminder_at?: string | null
          followup_task_id?: string | null
          id?: string
          prefix?: string | null
          template_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "field_logs_followup_task_id_user_id_fkey"
            columns: ["followup_task_id", "user_id"]
            isOneToOne: false
            referencedRelation: "goals"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "field_logs_template_id_user_id_fkey"
            columns: ["template_id", "user_id"]
            isOneToOne: false
            referencedRelation: "field_log_templates"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "field_logs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      goal_backlog: {
        Row: {
          created_at: string
          id: string
          notes: string | null
          promoted_to_goal_id: string | null
          source: Database["public"]["Enums"]["backlog_source"]
          source_id: string | null
          title: string
          user_id: string
          virtue_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          notes?: string | null
          promoted_to_goal_id?: string | null
          source?: Database["public"]["Enums"]["backlog_source"]
          source_id?: string | null
          title: string
          user_id: string
          virtue_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          notes?: string | null
          promoted_to_goal_id?: string | null
          source?: Database["public"]["Enums"]["backlog_source"]
          source_id?: string | null
          title?: string
          user_id?: string
          virtue_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "goal_backlog_promoted_to_goal_id_user_id_fkey"
            columns: ["promoted_to_goal_id", "user_id"]
            isOneToOne: false
            referencedRelation: "goals"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "goal_backlog_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "goal_backlog_virtue_id_user_id_fkey"
            columns: ["virtue_id", "user_id"]
            isOneToOne: false
            referencedRelation: "virtues"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      goal_virtues: {
        Row: {
          goal_id: string
          user_id: string
          virtue_id: string
        }
        Insert: {
          goal_id: string
          user_id: string
          virtue_id: string
        }
        Update: {
          goal_id?: string
          user_id?: string
          virtue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "goal_virtues_goal_id_user_id_fkey"
            columns: ["goal_id", "user_id"]
            isOneToOne: false
            referencedRelation: "goals"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "goal_virtues_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "goal_virtues_virtue_id_user_id_fkey"
            columns: ["virtue_id", "user_id"]
            isOneToOne: false
            referencedRelation: "virtues"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      goals: {
        Row: {
          base_xp: number
          completed_at: string | null
          created_at: string
          description: string | null
          display_order: number
          due_date: string | null
          id: string
          is_quest: boolean
          parent_goal_id: string | null
          status: Database["public"]["Enums"]["goal_status"]
          title: string
          user_id: string
        }
        Insert: {
          base_xp?: number
          completed_at?: string | null
          created_at?: string
          description?: string | null
          display_order?: number
          due_date?: string | null
          id?: string
          is_quest?: boolean
          parent_goal_id?: string | null
          status?: Database["public"]["Enums"]["goal_status"]
          title: string
          user_id: string
        }
        Update: {
          base_xp?: number
          completed_at?: string | null
          created_at?: string
          description?: string | null
          display_order?: number
          due_date?: string | null
          id?: string
          is_quest?: boolean
          parent_goal_id?: string | null
          status?: Database["public"]["Enums"]["goal_status"]
          title?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "goals_parent_goal_id_user_id_fkey"
            columns: ["parent_goal_id", "user_id"]
            isOneToOne: false
            referencedRelation: "goals"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "goals_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      level_thresholds: {
        Row: {
          cumulative_xp: number
          level: number
          xp_required: number
        }
        Insert: {
          cumulative_xp: number
          level: number
          xp_required: number
        }
        Update: {
          cumulative_xp?: number
          level?: number
          xp_required?: number
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          current_streak: number
          display_name: string | null
          email: string | null
          global_level: number
          global_xp: number
          id: string
          last_active_at: string | null
          longest_streak: number
          streak_calculated_on: string | null
          streak_multiplier: number
          subscription_expires_at: string | null
          subscription_tier: Database["public"]["Enums"]["subscription_tier"]
          timezone: string
        }
        Insert: {
          created_at?: string
          current_streak?: number
          display_name?: string | null
          email?: string | null
          global_level?: number
          global_xp?: number
          id: string
          last_active_at?: string | null
          longest_streak?: number
          streak_calculated_on?: string | null
          streak_multiplier?: number
          subscription_expires_at?: string | null
          subscription_tier?: Database["public"]["Enums"]["subscription_tier"]
          timezone?: string
        }
        Update: {
          created_at?: string
          current_streak?: number
          display_name?: string | null
          email?: string | null
          global_level?: number
          global_xp?: number
          id?: string
          last_active_at?: string | null
          longest_streak?: number
          streak_calculated_on?: string | null
          streak_multiplier?: number
          subscription_expires_at?: string | null
          subscription_tier?: Database["public"]["Enums"]["subscription_tier"]
          timezone?: string
        }
        Relationships: []
      }
      retrospectives: {
        Row: {
          analytics_data: Json | null
          chat_history: Json
          created_at: string
          generated_report: Json | null
          id: string
          period_end: string
          period_start: string
          period_type: Database["public"]["Enums"]["retro_period_type"]
          status: Database["public"]["Enums"]["retro_status"]
          user_id: string
          user_notes: string | null
          xp_earned: number | null
        }
        Insert: {
          analytics_data?: Json | null
          chat_history?: Json
          created_at?: string
          generated_report?: Json | null
          id?: string
          period_end: string
          period_start: string
          period_type: Database["public"]["Enums"]["retro_period_type"]
          status?: Database["public"]["Enums"]["retro_status"]
          user_id: string
          user_notes?: string | null
          xp_earned?: number | null
        }
        Update: {
          analytics_data?: Json | null
          chat_history?: Json
          created_at?: string
          generated_report?: Json | null
          id?: string
          period_end?: string
          period_start?: string
          period_type?: Database["public"]["Enums"]["retro_period_type"]
          status?: Database["public"]["Enums"]["retro_status"]
          user_id?: string
          user_notes?: string | null
          xp_earned?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "retrospectives_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      routine_completions: {
        Row: {
          completed_at: string
          completed_on: string
          id: string
          routine_id: string
          streak_multiplier_at_time: number
          user_id: string
          xp_earned: number
        }
        Insert: {
          completed_at?: string
          completed_on: string
          id?: string
          routine_id: string
          streak_multiplier_at_time?: number
          user_id: string
          xp_earned?: number
        }
        Update: {
          completed_at?: string
          completed_on?: string
          id?: string
          routine_id?: string
          streak_multiplier_at_time?: number
          user_id?: string
          xp_earned?: number
        }
        Relationships: [
          {
            foreignKeyName: "routine_completions_routine_id_user_id_fkey"
            columns: ["routine_id", "user_id"]
            isOneToOne: false
            referencedRelation: "routines"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "routine_completions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      routine_virtues: {
        Row: {
          routine_id: string
          user_id: string
          virtue_id: string
        }
        Insert: {
          routine_id: string
          user_id: string
          virtue_id: string
        }
        Update: {
          routine_id?: string
          user_id?: string
          virtue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "routine_virtues_routine_id_user_id_fkey"
            columns: ["routine_id", "user_id"]
            isOneToOne: false
            referencedRelation: "routines"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "routine_virtues_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "routine_virtues_virtue_id_user_id_fkey"
            columns: ["virtue_id", "user_id"]
            isOneToOne: false
            referencedRelation: "virtues"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      routines: {
        Row: {
          base_xp: number | null
          created_at: string
          description: string | null
          frequency: Database["public"]["Enums"]["routine_frequency"]
          id: string
          is_active: boolean
          scheduled_day: number | null
          title: string
          user_id: string
        }
        Insert: {
          base_xp?: number | null
          created_at?: string
          description?: string | null
          frequency: Database["public"]["Enums"]["routine_frequency"]
          id?: string
          is_active?: boolean
          scheduled_day?: number | null
          title: string
          user_id: string
        }
        Update: {
          base_xp?: number | null
          created_at?: string
          description?: string | null
          frequency?: Database["public"]["Enums"]["routine_frequency"]
          id?: string
          is_active?: boolean
          scheduled_day?: number | null
          title?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "routines_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      session_instances: {
        Row: {
          actual_duration_seconds: number | null
          created_at: string
          ended_at: string | null
          focus_mode_activated: boolean
          id: string
          scheduled_at: string | null
          session_id: string
          skip_penalty_xp: number | null
          started_at: string | null
          status: Database["public"]["Enums"]["session_instance_status"]
          user_id: string
          xp_earned: number | null
        }
        Insert: {
          actual_duration_seconds?: number | null
          created_at?: string
          ended_at?: string | null
          focus_mode_activated?: boolean
          id?: string
          scheduled_at?: string | null
          session_id: string
          skip_penalty_xp?: number | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["session_instance_status"]
          user_id: string
          xp_earned?: number | null
        }
        Update: {
          actual_duration_seconds?: number | null
          created_at?: string
          ended_at?: string | null
          focus_mode_activated?: boolean
          id?: string
          scheduled_at?: string | null
          session_id?: string
          skip_penalty_xp?: number | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["session_instance_status"]
          user_id?: string
          xp_earned?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "session_instances_session_id_user_id_fkey"
            columns: ["session_id", "user_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "session_instances_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      session_virtues: {
        Row: {
          session_id: string
          user_id: string
          virtue_id: string
        }
        Insert: {
          session_id: string
          user_id: string
          virtue_id: string
        }
        Update: {
          session_id?: string
          user_id?: string
          virtue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_virtues_session_id_user_id_fkey"
            columns: ["session_id", "user_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "session_virtues_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_virtues_virtue_id_user_id_fkey"
            columns: ["virtue_id", "user_id"]
            isOneToOne: false
            referencedRelation: "virtues"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      sessions: {
        Row: {
          base_xp: number | null
          created_at: string
          id: string
          is_active: boolean
          recurrence_rule: Json | null
          target_duration_minutes: number
          title: string
          user_id: string
        }
        Insert: {
          base_xp?: number | null
          created_at?: string
          id?: string
          is_active?: boolean
          recurrence_rule?: Json | null
          target_duration_minutes: number
          title: string
          user_id: string
        }
        Update: {
          base_xp?: number | null
          created_at?: string
          id?: string
          is_active?: boolean
          recurrence_rule?: Json | null
          target_duration_minutes?: number
          title?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sessions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      virtues: {
        Row: {
          color: string | null
          created_at: string
          display_order: number
          icon: string | null
          id: string
          level: number
          name: string
          user_id: string
          xp: number
        }
        Insert: {
          color?: string | null
          created_at?: string
          display_order?: number
          icon?: string | null
          id?: string
          level?: number
          name: string
          user_id: string
          xp?: number
        }
        Update: {
          color?: string | null
          created_at?: string
          display_order?: number
          icon?: string | null
          id?: string
          level?: number
          name?: string
          user_id?: string
          xp?: number
        }
        Relationships: [
          {
            foreignKeyName: "virtues_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      xp_ledger: {
        Row: {
          base_xp: number
          created_at: string
          description: string | null
          final_xp: number
          id: string
          multiplier: number
          source_id: string | null
          source_type: Database["public"]["Enums"]["xp_source_type"]
          user_id: string
          virtue_id: string | null
        }
        Insert: {
          base_xp: number
          created_at?: string
          description?: string | null
          final_xp: number
          id?: string
          multiplier?: number
          source_id?: string | null
          source_type: Database["public"]["Enums"]["xp_source_type"]
          user_id: string
          virtue_id?: string | null
        }
        Update: {
          base_xp?: number
          created_at?: string
          description?: string | null
          final_xp?: number
          id?: string
          multiplier?: number
          source_id?: string | null
          source_type?: Database["public"]["Enums"]["xp_source_type"]
          user_id?: string
          virtue_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "xp_ledger_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "xp_ledger_virtue_id_user_id_fkey"
            columns: ["virtue_id", "user_id"]
            isOneToOne: false
            referencedRelation: "virtues"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      calculate_and_award_xp: {
        Args: {
          p_base_xp: number
          p_description?: string
          p_source_id: string
          p_source_type: Database["public"]["Enums"]["xp_source_type"]
          p_user_id: string
          p_virtue_ids?: string[]
        }
        Returns: Json
      }
      default_routine_xp: {
        Args: { p_frequency: Database["public"]["Enums"]["routine_frequency"] }
        Returns: number
      }
      default_session_xp: { Args: { p_minutes: number }; Returns: number }
      level_for_xp: { Args: { p_xp: number }; Returns: number }
      recalculate_streak: { Args: { p_user_id: string }; Returns: number }
      xp_for_level: { Args: { p_level: number }; Returns: number }
    }
    Enums: {
      backlog_source: "manual" | "ai_suggestion" | "field_log"
      goal_status: "backlog" | "active" | "completed" | "archived"
      prompt_type: "text" | "textarea" | "select" | "scale"
      retro_period_type: "weekly" | "monthly"
      retro_status: "generated" | "reviewed" | "skipped"
      routine_frequency: "daily" | "weekly" | "monthly"
      session_instance_status:
        | "scheduled"
        | "in_progress"
        | "completed"
        | "skipped"
      subscription_tier: "free" | "premium"
      xp_source_type:
        | "routine"
        | "goal"
        | "session"
        | "retrospective"
        | "bonus"
        | "penalty"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      backlog_source: ["manual", "ai_suggestion", "field_log"],
      goal_status: ["backlog", "active", "completed", "archived"],
      prompt_type: ["text", "textarea", "select", "scale"],
      retro_period_type: ["weekly", "monthly"],
      retro_status: ["generated", "reviewed", "skipped"],
      routine_frequency: ["daily", "weekly", "monthly"],
      session_instance_status: [
        "scheduled",
        "in_progress",
        "completed",
        "skipped",
      ],
      subscription_tier: ["free", "premium"],
      xp_source_type: [
        "routine",
        "goal",
        "session",
        "retrospective",
        "bonus",
        "penalty",
      ],
    },
  },
} as const

