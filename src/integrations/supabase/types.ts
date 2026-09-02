export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      agents: {
        Row: {
          business_knowledge: string
          created_at: string
          data_fields: Json
          end_call_conditions: Json
          greeting: string
          id: string
          language: string
          max_retries: number
          name: string
          objective: string
          personality: string
          playbook: string | null
          playbook_calls_analyzed: number
          playbook_updated_at: string | null
          prompt: string
          qualification_questions: Json
          retry_delay_minutes: number
          speak_first: boolean
          system_prompt: string
          temperature: number
          transfer_number: string
          tts_engine: string
          updated_at: string
          user_id: string
          voice_id: string
          voice_name: string
          voice_similarity_boost: number | null
          voice_speaker_boost: boolean | null
          voice_stability: number | null
          voice_style: number | null
          voicemail_handling: string
          voicemail_message: string
        }
        Insert: {
          business_knowledge?: string
          created_at?: string
          data_fields?: Json
          end_call_conditions?: Json
          greeting?: string
          id?: string
          language?: string
          max_retries?: number
          name: string
          objective?: string
          personality?: string
          playbook?: string | null
          playbook_calls_analyzed?: number
          playbook_updated_at?: string | null
          prompt?: string
          qualification_questions?: Json
          retry_delay_minutes?: number
          speak_first?: boolean
          system_prompt?: string
          temperature?: number
          transfer_number?: string
          tts_engine?: string
          updated_at?: string
          user_id: string
          voice_id?: string
          voice_name?: string
          voice_similarity_boost?: number | null
          voice_speaker_boost?: boolean | null
          voice_stability?: number | null
          voice_style?: number | null
          voicemail_handling?: string
          voicemail_message?: string
        }
        Update: {
          business_knowledge?: string
          created_at?: string
          data_fields?: Json
          end_call_conditions?: Json
          greeting?: string
          id?: string
          language?: string
          max_retries?: number
          name?: string
          objective?: string
          personality?: string
          playbook?: string | null
          playbook_calls_analyzed?: number
          playbook_updated_at?: string | null
          prompt?: string
          qualification_questions?: Json
          retry_delay_minutes?: number
          speak_first?: boolean
          system_prompt?: string
          temperature?: number
          transfer_number?: string
          tts_engine?: string
          updated_at?: string
          user_id?: string
          voice_id?: string
          voice_name?: string
          voice_similarity_boost?: number | null
          voice_speaker_boost?: boolean | null
          voice_stability?: number | null
          voice_style?: number | null
          voicemail_handling?: string
          voicemail_message?: string
        }
        Relationships: []
      }
      appointments: {
        Row: {
          call_id: string | null
          contact_name: string
          contact_phone: string
          created_at: string
          id: string
          notes: string
          scheduled_at: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          call_id?: string | null
          contact_name?: string
          contact_phone?: string
          created_at?: string
          id?: string
          notes?: string
          scheduled_at: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          call_id?: string | null
          contact_name?: string
          contact_phone?: string
          created_at?: string
          id?: string
          notes?: string
          scheduled_at?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "appointments_call_id_fkey"
            columns: ["call_id"]
            isOneToOne: false
            referencedRelation: "calls"
            referencedColumns: ["id"]
          },
        ]
      }
      automations: {
        Row: {
          action: string
          config: Json
          created_at: string
          enabled: boolean
          id: string
          name: string
          trigger: string
          updated_at: string
          user_id: string
        }
        Insert: {
          action?: string
          config?: Json
          created_at?: string
          enabled?: boolean
          id?: string
          name: string
          trigger?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          action?: string
          config?: Json
          created_at?: string
          enabled?: boolean
          id?: string
          name?: string
          trigger?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      call_reflections: {
        Row: {
          agent_id: string
          attempts: number
          call_id: string
          created_at: string
          id: string
          key_learnings: Json
          last_error: string | null
          next_attempt_at: string | null
          objections: Json
          status: string
          success_label: string | null
          success_score: number | null
          summary: string | null
          updated_at: string
          user_id: string
          what_failed: Json
          what_worked: Json
        }
        Insert: {
          agent_id: string
          attempts?: number
          call_id: string
          created_at?: string
          id?: string
          key_learnings?: Json
          last_error?: string | null
          next_attempt_at?: string | null
          objections?: Json
          status?: string
          success_label?: string | null
          success_score?: number | null
          summary?: string | null
          updated_at?: string
          user_id: string
          what_failed?: Json
          what_worked?: Json
        }
        Update: {
          agent_id?: string
          attempts?: number
          call_id?: string
          created_at?: string
          id?: string
          key_learnings?: Json
          last_error?: string | null
          next_attempt_at?: string | null
          objections?: Json
          status?: string
          success_label?: string | null
          success_score?: number | null
          summary?: string | null
          updated_at?: string
          user_id?: string
          what_failed?: Json
          what_worked?: Json
        }
        Relationships: [
          {
            foreignKeyName: "call_reflections_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_reflections_call_id_fkey"
            columns: ["call_id"]
            isOneToOne: true
            referencedRelation: "calls"
            referencedColumns: ["id"]
          },
        ]
      }
      calls: {
        Row: {
          agent_id: string | null
          ai_minutes: number
          appointment_booked: boolean
          campaign_id: string | null
          contact_id: string | null
          cost_cents: number
          created_at: string
          duration_sec: number
          end_reason: string | null
          ended_at: string | null
          extracted_data: Json
          id: string
          outcome: string
          phone_from: string
          phone_to: string
          recording_url: string | null
          sentiment: string | null
          started_at: string
          status: string
          summary: string
          transcript: Json
          twilio_call_sid: string
          updated_at: string
          user_id: string
        }
        Insert: {
          agent_id?: string | null
          ai_minutes?: number
          appointment_booked?: boolean
          campaign_id?: string | null
          contact_id?: string | null
          cost_cents?: number
          created_at?: string
          duration_sec?: number
          end_reason?: string | null
          ended_at?: string | null
          extracted_data?: Json
          id?: string
          outcome?: string
          phone_from?: string
          phone_to?: string
          recording_url?: string | null
          sentiment?: string | null
          started_at?: string
          status?: string
          summary?: string
          transcript?: Json
          twilio_call_sid?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          agent_id?: string | null
          ai_minutes?: number
          appointment_booked?: boolean
          campaign_id?: string | null
          contact_id?: string | null
          cost_cents?: number
          created_at?: string
          duration_sec?: number
          end_reason?: string | null
          ended_at?: string | null
          extracted_data?: Json
          id?: string
          outcome?: string
          phone_from?: string
          phone_to?: string
          recording_url?: string | null
          sentiment?: string | null
          started_at?: string
          status?: string
          summary?: string
          transcript?: Json
          twilio_call_sid?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "calls_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calls_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calls_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      campaigns: {
        Row: {
          agent_id: string | null
          calling_hours: Json
          calls_per_minute: number
          created_at: string
          id: string
          list_id: string | null
          name: string
          phone_number_id: string | null
          retry_rules: Json
          status: string
          timezone: string
          updated_at: string
          user_id: string
          voicemail_rules: Json
        }
        Insert: {
          agent_id?: string | null
          calling_hours?: Json
          calls_per_minute?: number
          created_at?: string
          id?: string
          list_id?: string | null
          name: string
          phone_number_id?: string | null
          retry_rules?: Json
          status?: string
          timezone?: string
          updated_at?: string
          user_id: string
          voicemail_rules?: Json
        }
        Update: {
          agent_id?: string | null
          calling_hours?: Json
          calls_per_minute?: number
          created_at?: string
          id?: string
          list_id?: string | null
          name?: string
          phone_number_id?: string | null
          retry_rules?: Json
          status?: string
          timezone?: string
          updated_at?: string
          user_id?: string
          voicemail_rules?: Json
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaigns_list_id_fkey"
            columns: ["list_id"]
            isOneToOne: false
            referencedRelation: "contact_lists"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaigns_phone_number_id_fkey"
            columns: ["phone_number_id"]
            isOneToOne: false
            referencedRelation: "phone_numbers"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_lists: {
        Row: {
          created_at: string
          description: string
          id: string
          name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          description?: string
          id?: string
          name: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      contacts: {
        Row: {
          company: string
          created_at: string
          custom_vars: Json
          email: string
          id: string
          list_id: string | null
          name: string
          notes: string
          phone: string
          status: string
          tags: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          company?: string
          created_at?: string
          custom_vars?: Json
          email?: string
          id?: string
          list_id?: string | null
          name?: string
          notes?: string
          phone: string
          status?: string
          tags?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          company?: string
          created_at?: string
          custom_vars?: Json
          email?: string
          id?: string
          list_id?: string | null
          name?: string
          notes?: string
          phone?: string
          status?: string
          tags?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contacts_list_id_fkey"
            columns: ["list_id"]
            isOneToOne: false
            referencedRelation: "contact_lists"
            referencedColumns: ["id"]
          },
        ]
      }
      org_settings: {
        Row: {
          created_at: string
          has_elevenlabs: boolean
          has_openai: boolean
          has_twilio: boolean
          smtp_host: string
          smtp_port: number
          smtp_user: string
          time_zone: string
          updated_at: string
          user_id: string
          webhook_url: string
        }
        Insert: {
          created_at?: string
          has_elevenlabs?: boolean
          has_openai?: boolean
          has_twilio?: boolean
          smtp_host?: string
          smtp_port?: number
          smtp_user?: string
          time_zone?: string
          updated_at?: string
          user_id: string
          webhook_url?: string
        }
        Update: {
          created_at?: string
          has_elevenlabs?: boolean
          has_openai?: boolean
          has_twilio?: boolean
          smtp_host?: string
          smtp_port?: number
          smtp_user?: string
          time_zone?: string
          updated_at?: string
          user_id?: string
          webhook_url?: string
        }
        Relationships: []
      }
      phone_numbers: {
        Row: {
          capabilities: Json
          created_at: string
          id: string
          inbound_agent_id: string | null
          number: string
          twilio_sid: string
          type: string
          updated_at: string
          user_id: string
        }
        Insert: {
          capabilities?: Json
          created_at?: string
          id?: string
          inbound_agent_id?: string | null
          number: string
          twilio_sid?: string
          type?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          capabilities?: Json
          created_at?: string
          id?: string
          inbound_agent_id?: string | null
          number?: string
          twilio_sid?: string
          type?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "phone_numbers_inbound_agent_id_fkey"
            columns: ["inbound_agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string | null
          full_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "moderator" | "user"
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "moderator", "user"],
    },
  },
} as const
