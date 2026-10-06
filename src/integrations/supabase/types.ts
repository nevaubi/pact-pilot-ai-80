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
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      activity: {
        Row: {
          actor: string | null
          created_at: string
          id: string
          matter_id: string | null
          message: string
        }
        Insert: {
          actor?: string | null
          created_at?: string
          id?: string
          matter_id?: string | null
          message: string
        }
        Update: {
          actor?: string | null
          created_at?: string
          id?: string
          matter_id?: string | null
          message?: string
        }
        Relationships: [
          {
            foreignKeyName: "activity_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_runs: {
        Row: {
          created_at: string
          effort: string
          id: string
          input_tokens: number | null
          kind: string
          matter_id: string | null
          output_tokens: number | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          effort: string
          id?: string
          input_tokens?: number | null
          kind: string
          matter_id?: string | null
          output_tokens?: number | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          effort?: string
          id?: string
          input_tokens?: number | null
          kind?: string
          matter_id?: string | null
          output_tokens?: number | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_runs_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
        ]
      }
      authorities: {
        Row: {
          added_by: string | null
          checked_at: string | null
          citation: string
          content_hash: string | null
          created_at: string
          error: string | null
          fetch_url: string | null
          fetched_at: string | null
          id: string
          is_catalog: boolean
          jurisdiction: string
          key: string | null
          kind: string
          meta: Json
          mime: string | null
          source: string
          status: string
          storage_path: string | null
          summary: string | null
          text: string | null
          text_chars: number
          title: string
          topics: string[]
          updated_at: string
          url: string
          version_label: string | null
        }
        Insert: {
          added_by?: string | null
          checked_at?: string | null
          citation: string
          content_hash?: string | null
          created_at?: string
          error?: string | null
          fetch_url?: string | null
          fetched_at?: string | null
          id?: string
          is_catalog?: boolean
          jurisdiction?: string
          key?: string | null
          kind?: string
          meta?: Json
          mime?: string | null
          source?: string
          status?: string
          storage_path?: string | null
          summary?: string | null
          text?: string | null
          text_chars?: number
          title: string
          topics?: string[]
          updated_at?: string
          url: string
          version_label?: string | null
        }
        Update: {
          added_by?: string | null
          checked_at?: string | null
          citation?: string
          content_hash?: string | null
          created_at?: string
          error?: string | null
          fetch_url?: string | null
          fetched_at?: string | null
          id?: string
          is_catalog?: boolean
          jurisdiction?: string
          key?: string | null
          kind?: string
          meta?: Json
          mime?: string | null
          source?: string
          status?: string
          storage_path?: string | null
          summary?: string | null
          text?: string | null
          text_chars?: number
          title?: string
          topics?: string[]
          updated_at?: string
          url?: string
          version_label?: string | null
        }
        Relationships: []
      }
      authority_chunks: {
        Row: {
          authority_id: string
          body: string
          heading: string | null
          id: number
          idx: number
          tsv: unknown
        }
        Insert: {
          authority_id: string
          body: string
          heading?: string | null
          id?: never
          idx: number
          tsv?: unknown
        }
        Update: {
          authority_id?: string
          body?: string
          heading?: string | null
          id?: never
          idx?: number
          tsv?: unknown
        }
        Relationships: [
          {
            foreignKeyName: "authority_chunks_authority_id_fkey"
            columns: ["authority_id"]
            isOneToOne: false
            referencedRelation: "authorities"
            referencedColumns: ["id"]
          },
        ]
      }
      authority_updates: {
        Row: {
          abstract: string | null
          agency: string | null
          authority_id: string
          created_at: string
          doc_type: string | null
          document_number: string
          effective_on: string | null
          html_url: string | null
          id: string
          pdf_url: string | null
          publication_date: string | null
          title: string
        }
        Insert: {
          abstract?: string | null
          agency?: string | null
          authority_id: string
          created_at?: string
          doc_type?: string | null
          document_number: string
          effective_on?: string | null
          html_url?: string | null
          id?: string
          pdf_url?: string | null
          publication_date?: string | null
          title: string
        }
        Update: {
          abstract?: string | null
          agency?: string | null
          authority_id?: string
          created_at?: string
          doc_type?: string | null
          document_number?: string
          effective_on?: string | null
          html_url?: string | null
          id?: string
          pdf_url?: string | null
          publication_date?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "authority_updates_authority_id_fkey"
            columns: ["authority_id"]
            isOneToOne: false
            referencedRelation: "authorities"
            referencedColumns: ["id"]
          },
        ]
      }
      closing_items: {
        Row: {
          created_at: string
          deliverable: string
          due_on: string | null
          id: string
          matter_id: string
          notes: string | null
          position: number
          responsible: string | null
          status: string
        }
        Insert: {
          created_at?: string
          deliverable: string
          due_on?: string | null
          id?: string
          matter_id: string
          notes?: string | null
          position?: number
          responsible?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          deliverable?: string
          due_on?: string | null
          id?: string
          matter_id?: string
          notes?: string | null
          position?: number
          responsible?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "closing_items_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts: {
        Row: {
          created_at: string
          email: string | null
          id: string
          name: string
          organization: string | null
          phone: string | null
          role: string | null
        }
        Insert: {
          created_at?: string
          email?: string | null
          id?: string
          name: string
          organization?: string | null
          phone?: string | null
          role?: string | null
        }
        Update: {
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          organization?: string | null
          phone?: string | null
          role?: string | null
        }
        Relationships: []
      }
      deadlines: {
        Row: {
          created_at: string
          due_on: string
          id: string
          kind: string | null
          matter_id: string
          source: string
          title: string
        }
        Insert: {
          created_at?: string
          due_on: string
          id?: string
          kind?: string | null
          matter_id: string
          source?: string
          title: string
        }
        Update: {
          created_at?: string
          due_on?: string
          id?: string
          kind?: string | null
          matter_id?: string
          source?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "deadlines_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
        ]
      }
      drafts: {
        Row: {
          body: string
          created_at: string
          id: string
          matter_id: string
          status: string
          template_id: string | null
          title: string
          updated_at: string
        }
        Insert: {
          body: string
          created_at?: string
          id?: string
          matter_id: string
          status?: string
          template_id?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          matter_id?: string
          status?: string
          template_id?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "drafts_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "drafts_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "templates"
            referencedColumns: ["id"]
          },
        ]
      }
      files: {
        Row: {
          created_at: string
          doc_type: string | null
          extracted_text: string | null
          id: string
          matter_id: string | null
          name: string
          path: string
          size: number | null
        }
        Insert: {
          created_at?: string
          doc_type?: string | null
          extracted_text?: string | null
          id?: string
          matter_id?: string | null
          name: string
          path: string
          size?: number | null
        }
        Update: {
          created_at?: string
          doc_type?: string | null
          extracted_text?: string | null
          id?: string
          matter_id?: string | null
          name?: string
          path?: string
          size?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "files_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
        ]
      }
      matter_authorities: {
        Row: {
          authority_id: string
          created_at: string
          id: string
          matter_id: string
          note: string | null
        }
        Insert: {
          authority_id: string
          created_at?: string
          id?: string
          matter_id: string
          note?: string | null
        }
        Update: {
          authority_id?: string
          created_at?: string
          id?: string
          matter_id?: string
          note?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "matter_authorities_authority_id_fkey"
            columns: ["authority_id"]
            isOneToOne: false
            referencedRelation: "authorities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matter_authorities_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
        ]
      }
      matter_contacts: {
        Row: {
          contact_id: string
          id: string
          matter_id: string
          relationship: string | null
        }
        Insert: {
          contact_id: string
          id?: string
          matter_id: string
          relationship?: string | null
        }
        Update: {
          contact_id?: string
          id?: string
          matter_id?: string
          relationship?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "matter_contacts_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matter_contacts_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
        ]
      }
      matter_properties: {
        Row: {
          acceptance_date: string | null
          address: string | null
          city: string | null
          closing_date: string | null
          county: string
          earnest_money: number | null
          in_chicago: boolean
          last_tax_bill: number | null
          lender: string | null
          loan_amount: number | null
          matter_id: string
          notes: string | null
          pin: string | null
          property_type: string
          proration_pct: number
          purchase_price: number | null
          side: string
          state: string
          survey_date: string | null
          tax_year: number | null
          title_company: string | null
          updated_at: string
          year_built: number | null
          zip: string | null
        }
        Insert: {
          acceptance_date?: string | null
          address?: string | null
          city?: string | null
          closing_date?: string | null
          county?: string
          earnest_money?: number | null
          in_chicago?: boolean
          last_tax_bill?: number | null
          lender?: string | null
          loan_amount?: number | null
          matter_id: string
          notes?: string | null
          pin?: string | null
          property_type?: string
          proration_pct?: number
          purchase_price?: number | null
          side?: string
          state?: string
          survey_date?: string | null
          tax_year?: number | null
          title_company?: string | null
          updated_at?: string
          year_built?: number | null
          zip?: string | null
        }
        Update: {
          acceptance_date?: string | null
          address?: string | null
          city?: string | null
          closing_date?: string | null
          county?: string
          earnest_money?: number | null
          in_chicago?: boolean
          last_tax_bill?: number | null
          lender?: string | null
          loan_amount?: number | null
          matter_id?: string
          notes?: string | null
          pin?: string | null
          property_type?: string
          proration_pct?: number
          purchase_price?: number | null
          side?: string
          state?: string
          survey_date?: string | null
          tax_year?: number | null
          title_company?: string | null
          updated_at?: string
          year_built?: number | null
          zip?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "matter_properties_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: true
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
        ]
      }
      matters: {
        Row: {
          client: string | null
          created_at: string
          id: string
          number: string | null
          opened_on: string | null
          practice_area: string
          responsible: string | null
          status: string
          summary: string | null
          title: string
        }
        Insert: {
          client?: string | null
          created_at?: string
          id?: string
          number?: string | null
          opened_on?: string | null
          practice_area?: string
          responsible?: string | null
          status?: string
          summary?: string | null
          title: string
        }
        Update: {
          client?: string | null
          created_at?: string
          id?: string
          number?: string | null
          opened_on?: string | null
          practice_area?: string
          responsible?: string | null
          status?: string
          summary?: string | null
          title?: string
        }
        Relationships: []
      }
      notes: {
        Row: {
          body: string
          created_at: string
          id: string
          kind: string
          matter_id: string
          title: string | null
        }
        Insert: {
          body: string
          created_at?: string
          id?: string
          kind?: string
          matter_id: string
          title?: string | null
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          kind?: string
          matter_id?: string
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notes_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          full_name: string | null
          id: string
        }
        Insert: {
          created_at?: string
          full_name?: string | null
          id: string
        }
        Update: {
          created_at?: string
          full_name?: string | null
          id?: string
        }
        Relationships: []
      }
      reviews: {
        Row: {
          authority_ids: string[]
          created_at: string
          created_by: string | null
          decisions: Json
          effort: string
          file_ids: string[]
          id: string
          input_tokens: number | null
          kind: string
          matter_id: string
          output_tokens: number | null
          result: Json
          title: string
        }
        Insert: {
          authority_ids?: string[]
          created_at?: string
          created_by?: string | null
          decisions?: Json
          effort?: string
          file_ids?: string[]
          id?: string
          input_tokens?: number | null
          kind: string
          matter_id: string
          output_tokens?: number | null
          result?: Json
          title: string
        }
        Update: {
          authority_ids?: string[]
          created_at?: string
          created_by?: string | null
          decisions?: Json
          effort?: string
          file_ids?: string[]
          id?: string
          input_tokens?: number | null
          kind?: string
          matter_id?: string
          output_tokens?: number | null
          result?: Json
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "reviews_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          assignee: string | null
          created_at: string
          done: boolean
          due_on: string | null
          id: string
          matter_id: string
          source: string
          title: string
        }
        Insert: {
          assignee?: string | null
          created_at?: string
          done?: boolean
          due_on?: string | null
          id?: string
          matter_id: string
          source?: string
          title: string
        }
        Update: {
          assignee?: string | null
          created_at?: string
          done?: boolean
          due_on?: string | null
          id?: string
          matter_id?: string
          source?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_matter_id_fkey"
            columns: ["matter_id"]
            isOneToOne: false
            referencedRelation: "matters"
            referencedColumns: ["id"]
          },
        ]
      }
      templates: {
        Row: {
          body: string
          created_at: string
          id: string
          name: string
          path: string | null
          practice_area: string | null
        }
        Insert: {
          body: string
          created_at?: string
          id?: string
          name: string
          path?: string | null
          practice_area?: string | null
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          name?: string
          path?: string | null
          practice_area?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      search_authorities: {
        Args: {
          ids?: string[]
          jur?: string
          lim?: number
          q: string
          topic?: string
        }
        Returns: {
          authority_id: string
          body: string
          chunk_idx: number
          citation: string
          heading: string
          jurisdiction: string
          rank: number
          snippet: string
          title: string
          url: string
          version_label: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
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
    Enums: {},
  },
} as const
