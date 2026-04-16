import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { assertValidGroupFolder, isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import type {
  ListRuntimeJobsRequest,
  RuntimeOrchestrationJob,
  RuntimeOrchestrationJobList,
} from './andrea-runtime/types.js';
import {
  ActionBundleActionRecord,
  ActionBundleRecord,
  ActionBundleSnapshot,
  AlexaConversationContext,
  AlexaLinkedAccount,
  AlexaOAuthAuthorizationCodeRecord,
  AlexaOAuthRefreshTokenRecord,
  AlexaPendingSession,
  AgentThreadState,
  CommunicationSignalRecord,
  CommunicationThreadRecord,
  CompanionHandoffRecord,
  DelegationRuleRecord,
  EverydayListGroup,
  EverydayListGroupKind,
  EverydayListItem,
  EverydayListItemKind,
  EverydayListItemState,
  EverydayListScope,
  KnowledgeChunkRecord,
  KnowledgeIndexState,
  KnowledgeRetrievalHit,
  KnowledgeScope,
  KnowledgeSensitivity,
  KnowledgeSourceRecord,
  LifeThread,
  LifeThreadSignal,
  MissionRecord,
  MissionStepRecord,
  MessageActionRecord,
  NewMessage,
  OutcomeRecord,
  OperatingProfile,
  OperatingProfileStatus,
  OperatingProfileSuggestion,
  OperatingProfileSuggestionState,
  ProfileFact,
  ProfileFactWithSubject,
  ProfileSubject,
  PilotIssueRecord,
  PilotJourneyEventRecord,
  RegisteredGroup,
  ResponseFeedbackRecord,
  RitualProfile,
  RuntimeBackendCardContextRecord,
  RuntimeBackendChatSelectionRecord,
  RuntimeBackendJobCacheRecord,
  ScheduledTask,
  TaskRunLog,
} from './types.js';
import type { CalendarAutomationRecordInput } from './calendar-automations.js';

let db: Database.Database;

export interface CursorOperatorContextRecord {
  chat_jid: string;
  thread_id: string;
  selected_lane_id: string | null;
  selected_agent_id: string | null;
  selected_jobs_by_lane_json: string | null;
  last_list_snapshot_json: string | null;
  last_list_message_id: string | null;
  dashboard_message_id: string | null;
  updated_at: string;
}

export interface CursorMessageContextRecord {
  chat_jid: string;
  platform_message_id: string;
  thread_id: string | null;
  context_kind: string;
  lane_id: string | null;
  agent_id: string | null;
  payload_json: string | null;
  created_at: string;
}

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      thread_id TEXT,
      reply_to_id TEXT,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS calendar_automations (
      task_id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      automation_type TEXT NOT NULL,
      label TEXT NOT NULL,
      config_json TEXT NOT NULL,
      dedupe_state_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_calendar_automations_chat
      ON calendar_automations(chat_jid, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_calendar_automations_group
      ON calendar_automations(group_folder, updated_at DESC);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_threads (
      group_folder TEXT PRIMARY KEY,
      runtime TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      last_response_id TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_threads_updated
      ON agent_threads(updated_at DESC);
    CREATE TABLE IF NOT EXISTS runtime_backend_jobs (
      backend_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      thread_id TEXT,
      status TEXT NOT NULL,
      selected_runtime TEXT,
      prompt_preview TEXT NOT NULL,
      latest_output_text TEXT,
      error_text TEXT,
      log_file TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      PRIMARY KEY (backend_id, job_id)
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_backend_jobs_group_created
      ON runtime_backend_jobs(backend_id, group_folder, created_at DESC, job_id DESC);
    CREATE INDEX IF NOT EXISTS idx_runtime_backend_jobs_chat_updated
      ON runtime_backend_jobs(backend_id, chat_jid, updated_at DESC, job_id DESC);
    CREATE TABLE IF NOT EXISTS runtime_backend_card_contexts (
      backend_id TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      message_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      thread_id TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (backend_id, chat_jid, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_backend_card_contexts_job
      ON runtime_backend_card_contexts(backend_id, chat_jid, job_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runtime_backend_card_contexts_expires
      ON runtime_backend_card_contexts(expires_at);
    CREATE TABLE IF NOT EXISTS runtime_backend_chat_selection (
      backend_id TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      job_id TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (backend_id, chat_jid)
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_backend_chat_selection_updated
      ON runtime_backend_chat_selection(updated_at DESC);
    CREATE TABLE IF NOT EXISTS alexa_linked_accounts (
      access_token_hash TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      allowed_alexa_user_id TEXT,
      allowed_alexa_person_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      disabled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_alexa_linked_accounts_group
      ON alexa_linked_accounts(group_folder, updated_at DESC);
    CREATE TABLE IF NOT EXISTS alexa_sessions (
      principal_key TEXT PRIMARY KEY,
      access_token_hash TEXT NOT NULL,
      pending_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alexa_sessions_expires
      ON alexa_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS alexa_conversation_contexts (
      principal_key TEXT PRIMARY KEY,
      access_token_hash TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      flow_key TEXT NOT NULL,
      subject_kind TEXT NOT NULL,
      subject_json TEXT NOT NULL,
      summary_text TEXT NOT NULL,
      supported_followups_json TEXT NOT NULL,
      style_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alexa_conversation_contexts_expires
      ON alexa_conversation_contexts(expires_at);
    CREATE TABLE IF NOT EXISTS alexa_oauth_authorization_codes (
      code_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      scope TEXT NOT NULL,
      code_challenge TEXT,
      code_challenge_method TEXT,
      group_folder TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_alexa_oauth_codes_expires
      ON alexa_oauth_authorization_codes(expires_at, used_at);
    CREATE TABLE IF NOT EXISTS alexa_oauth_refresh_tokens (
      refresh_token_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      disabled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_alexa_oauth_refresh_expires
      ON alexa_oauth_refresh_tokens(expires_at, disabled_at);
    CREATE TABLE IF NOT EXISTS profile_subjects (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      kind TEXT NOT NULL,
      canonical_name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      disabled_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_subjects_unique
      ON profile_subjects(group_folder, kind, canonical_name);
    CREATE INDEX IF NOT EXISTS idx_profile_subjects_group
      ON profile_subjects(group_folder, updated_at DESC);
    CREATE TABLE IF NOT EXISTS profile_facts (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      category TEXT NOT NULL,
      fact_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      state TEXT NOT NULL,
      source_channel TEXT NOT NULL,
      source_summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_facts_unique
      ON profile_facts(group_folder, subject_id, category, fact_key);
    CREATE INDEX IF NOT EXISTS idx_profile_facts_group
      ON profile_facts(group_folder, state, updated_at DESC);
    CREATE TABLE IF NOT EXISTS operating_profiles (
      profile_id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      status TEXT NOT NULL,
      version INTEGER NOT NULL,
      based_on_profile_id TEXT,
      intake_json TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      source_channel TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      approved_at TEXT,
      superseded_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_operating_profiles_group
      ON operating_profiles(group_folder, status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS operating_profile_suggestions (
      suggestion_id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      profile_id TEXT,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      suggestion_json TEXT NOT NULL,
      state TEXT NOT NULL,
      source_channel TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_operating_profile_suggestions_group
      ON operating_profile_suggestions(group_folder, state, updated_at DESC);
    CREATE TABLE IF NOT EXISTS everyday_list_groups (
      group_id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      operating_profile_id TEXT,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      scope TEXT NOT NULL,
      source_summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_everyday_list_groups_unique
      ON everyday_list_groups(group_folder, title);
    CREATE INDEX IF NOT EXISTS idx_everyday_list_groups_group
      ON everyday_list_groups(group_folder, kind, updated_at DESC);
    CREATE TABLE IF NOT EXISTS everyday_list_items (
      item_id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      group_id TEXT NOT NULL,
      operating_profile_id TEXT,
      title TEXT NOT NULL,
      item_kind TEXT NOT NULL,
      state TEXT NOT NULL,
      scope TEXT NOT NULL,
      source_channel TEXT NOT NULL,
      source_summary TEXT NOT NULL,
      detail_json TEXT,
      linkage_json TEXT,
      due_at TEXT,
      scheduled_for TEXT,
      defer_until TEXT,
      recurrence_kind TEXT NOT NULL DEFAULT 'none',
      recurrence_interval INTEGER NOT NULL DEFAULT 1,
      recurrence_days_json TEXT,
      recurrence_day_of_month INTEGER,
      recurrence_anchor_at TEXT,
      recurrence_next_due_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_everyday_list_items_group
      ON everyday_list_items(group_folder, state, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_everyday_list_items_list
      ON everyday_list_items(group_id, state, updated_at DESC);
    CREATE TABLE IF NOT EXISTS knowledge_sources (
      source_id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      source_type TEXT NOT NULL,
      title TEXT NOT NULL,
      short_summary TEXT NOT NULL,
      content_ref TEXT,
      normalized_text TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      scope TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      ingestion_state TEXT NOT NULL,
      index_state TEXT NOT NULL,
      source_channel TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT,
      disabled_at TEXT,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_sources_group_updated
      ON knowledge_sources(group_folder, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_sources_group_title
      ON knowledge_sources(group_folder, title COLLATE NOCASE ASC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_sources_group_state
      ON knowledge_sources(group_folder, ingestion_state, index_state, updated_at DESC);
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      chunk_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      char_length INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (source_id) REFERENCES knowledge_sources(source_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_source
      ON knowledge_chunks(source_id, chunk_index ASC);
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
      chunk_id UNINDEXED,
      source_id UNINDEXED,
      title,
      tags,
      content
    );
    CREATE TABLE IF NOT EXISTS ritual_profiles (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      ritual_type TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      trigger_style TEXT NOT NULL,
      scope TEXT NOT NULL,
      timing_json TEXT NOT NULL,
      tone_style TEXT NOT NULL,
      source_inputs_json TEXT NOT NULL,
      last_run_at TEXT,
      next_due_at TEXT,
      opt_in_state TEXT NOT NULL,
      linked_task_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ritual_profiles_group_type
      ON ritual_profiles(group_folder, ritual_type);
    CREATE INDEX IF NOT EXISTS idx_ritual_profiles_group_updated
      ON ritual_profiles(group_folder, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ritual_profiles_group_due
      ON ritual_profiles(group_folder, enabled, next_due_at);
    CREATE TABLE IF NOT EXISTS communication_threads (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      title TEXT NOT NULL,
      linked_subject_ids_json TEXT NOT NULL,
      linked_life_thread_ids_json TEXT NOT NULL,
      channel TEXT NOT NULL,
      channel_chat_jid TEXT,
      last_inbound_summary TEXT,
      last_outbound_summary TEXT,
      followup_state TEXT NOT NULL,
      urgency TEXT NOT NULL,
      followup_due_at TEXT,
      suggested_next_action TEXT,
      tone_style_hints_json TEXT NOT NULL,
      last_contact_at TEXT,
      last_message_id TEXT,
      linked_task_id TEXT,
      inference_state TEXT NOT NULL,
      tracking_mode TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      disabled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_communication_threads_group_updated
      ON communication_threads(group_folder, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_communication_threads_group_followup
      ON communication_threads(group_folder, tracking_mode, followup_state, updated_at DESC);
    CREATE TABLE IF NOT EXISTS communication_signals (
      id TEXT PRIMARY KEY,
      communication_thread_id TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      source_channel TEXT NOT NULL,
      chat_jid TEXT,
      message_id TEXT,
      direction TEXT NOT NULL,
      summary_text TEXT NOT NULL,
      followup_state TEXT NOT NULL,
      suggested_action TEXT,
      urgency TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (communication_thread_id) REFERENCES communication_threads(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_communication_signals_thread
      ON communication_signals(communication_thread_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_communication_signals_group
      ON communication_signals(group_folder, created_at DESC);
    CREATE TABLE IF NOT EXISTS pilot_journey_events (
      event_id TEXT PRIMARY KEY,
      journey_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      chat_jid TEXT,
      thread_id TEXT,
      route_key TEXT,
      systems_involved_json TEXT NOT NULL,
      outcome TEXT NOT NULL,
      blocker_class TEXT,
      blocker_owner TEXT NOT NULL,
      degraded_path TEXT,
      handoff_created INTEGER NOT NULL DEFAULT 0,
      mission_created INTEGER NOT NULL DEFAULT 0,
      thread_saved INTEGER NOT NULL DEFAULT 0,
      reminder_created INTEGER NOT NULL DEFAULT 0,
      library_saved INTEGER NOT NULL DEFAULT 0,
      current_work_ref TEXT,
      summary_text TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_pilot_journey_events_group_started
      ON pilot_journey_events(group_folder, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pilot_journey_events_journey_completed
      ON pilot_journey_events(journey_id, completed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pilot_journey_events_outcome_completed
      ON pilot_journey_events(outcome, completed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pilot_journey_events_chat_started
      ON pilot_journey_events(chat_jid, started_at DESC);
    CREATE TABLE IF NOT EXISTS pilot_issues (
      issue_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL,
      issue_kind TEXT NOT NULL,
      channel TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      chat_jid TEXT,
      thread_id TEXT,
      journey_event_id TEXT,
      route_key TEXT,
      blocker_class TEXT,
      blocker_owner TEXT NOT NULL,
      summary_text TEXT NOT NULL,
      assistant_context_summary TEXT NOT NULL,
      linked_refs_json TEXT NOT NULL,
      FOREIGN KEY (journey_event_id) REFERENCES pilot_journey_events(event_id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pilot_issues_status_created
      ON pilot_issues(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pilot_issues_journey
      ON pilot_issues(journey_event_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pilot_issues_group_chat
      ON pilot_issues(group_folder, chat_jid, created_at DESC);
    CREATE TABLE IF NOT EXISTS missions (
      mission_id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      title TEXT NOT NULL,
      objective TEXT NOT NULL,
      category TEXT NOT NULL,
      status TEXT NOT NULL,
      scope TEXT NOT NULL,
      linked_life_thread_ids_json TEXT NOT NULL,
      linked_subject_ids_json TEXT NOT NULL,
      linked_reminder_ids_json TEXT NOT NULL,
      linked_current_work_json TEXT,
      linked_knowledge_source_ids_json TEXT NOT NULL,
      summary TEXT NOT NULL,
      suggested_next_action_json TEXT,
      blockers_json TEXT,
      due_horizon TEXT,
      due_at TEXT,
      muted_suggested_action_kinds_json TEXT NOT NULL,
      user_confirmed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_missions_group_updated
      ON missions(group_folder, last_updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_missions_group_status
      ON missions(group_folder, status, user_confirmed, last_updated_at DESC);
    CREATE TABLE IF NOT EXISTS mission_steps (
      step_id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      title TEXT NOT NULL,
      detail TEXT,
      step_status TEXT NOT NULL,
      requires_user_judgment INTEGER NOT NULL DEFAULT 0,
      suggested_action_kind TEXT,
      linked_ref_json TEXT,
      last_updated_at TEXT NOT NULL,
      FOREIGN KEY (mission_id) REFERENCES missions(mission_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_mission_steps_mission_position
      ON mission_steps(mission_id, position ASC);
    CREATE TABLE IF NOT EXISTS companion_handoffs (
      handoff_id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      origin_channel TEXT NOT NULL,
      target_channel TEXT NOT NULL,
      target_chat_jid TEXT,
      capability_id TEXT,
      voice_summary TEXT NOT NULL,
      rich_payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      requires_confirmation INTEGER NOT NULL DEFAULT 0,
      thread_id TEXT,
      task_id TEXT,
      communication_thread_id TEXT,
      communication_subject_ids_json TEXT,
      communication_life_thread_ids_json TEXT,
      last_communication_summary TEXT,
      mission_id TEXT,
      mission_summary TEXT,
      mission_suggested_actions_json TEXT,
      mission_blockers_json TEXT,
      mission_step_focus_json TEXT,
      knowledge_source_ids_json TEXT,
      work_ref TEXT,
      followup_suggestions_json TEXT,
      delivered_message_id TEXT,
      error_text TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_companion_handoffs_group_created
      ON companion_handoffs(group_folder, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_companion_handoffs_status_expires
      ON companion_handoffs(status, expires_at ASC);
    CREATE TABLE IF NOT EXISTS action_bundles (
      bundle_id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      title TEXT NOT NULL,
      origin_kind TEXT NOT NULL,
      origin_capability TEXT,
      source_context_key TEXT,
      source_context_json TEXT NOT NULL,
      presentation_channel TEXT NOT NULL,
      presentation_chat_jid TEXT,
      presentation_thread_id TEXT,
      presentation_message_id TEXT,
      presentation_mode TEXT,
      bundle_status TEXT NOT NULL,
      user_confirmed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_updated_at TEXT NOT NULL,
      related_refs_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_action_bundles_group_updated
      ON action_bundles(group_folder, last_updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_action_bundles_source_open
      ON action_bundles(group_folder, source_context_key, bundle_status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_action_bundles_chat_open
      ON action_bundles(group_folder, presentation_chat_jid, presentation_channel, bundle_status, last_updated_at DESC);
    CREATE TABLE IF NOT EXISTS action_bundle_actions (
      action_id TEXT PRIMARY KEY,
      bundle_id TEXT NOT NULL,
      order_index INTEGER NOT NULL,
      action_type TEXT NOT NULL,
      target_system TEXT NOT NULL,
      summary TEXT NOT NULL,
      requires_confirmation INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      delegation_rule_id TEXT,
      delegation_mode TEXT,
      delegation_explanation TEXT,
      failure_reason TEXT,
      payload_json TEXT NOT NULL,
      result_ref_json TEXT,
      created_at TEXT NOT NULL,
      last_updated_at TEXT NOT NULL,
      FOREIGN KEY (bundle_id) REFERENCES action_bundles(bundle_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_action_bundle_actions_bundle_order
      ON action_bundle_actions(bundle_id, order_index ASC);
    CREATE TABLE IF NOT EXISTS delegation_rules (
      rule_id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      title TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      trigger_scope TEXT NOT NULL,
      conditions_json TEXT NOT NULL,
      delegated_actions_json TEXT NOT NULL,
      approval_mode TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      times_used INTEGER NOT NULL DEFAULT 0,
      times_auto_applied INTEGER NOT NULL DEFAULT 0,
      times_overridden INTEGER NOT NULL DEFAULT 0,
      last_outcome_status TEXT,
      user_confirmed INTEGER NOT NULL DEFAULT 0,
      channel_applicability_json TEXT NOT NULL,
      safety_level TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_delegation_rules_group_status
      ON delegation_rules(group_folder, status, last_used_at DESC, created_at DESC);
    CREATE TABLE IF NOT EXISTS message_actions (
      message_action_id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_key TEXT NOT NULL,
      source_summary TEXT,
      target_kind TEXT NOT NULL,
      target_channel TEXT NOT NULL,
      target_conversation_json TEXT NOT NULL,
      draft_text TEXT NOT NULL,
      trust_level TEXT NOT NULL,
      send_status TEXT NOT NULL,
      followup_at TEXT,
      requires_approval INTEGER NOT NULL DEFAULT 1,
      delegation_rule_id TEXT,
      delegation_mode TEXT,
      explanation_json TEXT,
      linked_refs_json TEXT,
      platform_message_id TEXT,
      scheduled_task_id TEXT,
      approved_at TEXT,
      last_action_kind TEXT,
      last_action_at TEXT,
      dedupe_key TEXT NOT NULL,
      presentation_chat_jid TEXT,
      presentation_thread_id TEXT,
      presentation_message_id TEXT,
      created_at TEXT NOT NULL,
      last_updated_at TEXT NOT NULL,
      sent_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_message_actions_dedupe
      ON message_actions(group_folder, dedupe_key);
    CREATE INDEX IF NOT EXISTS idx_message_actions_source
      ON message_actions(group_folder, source_type, source_key, last_updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_message_actions_group_updated
      ON message_actions(group_folder, last_updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_message_actions_group_status
      ON message_actions(group_folder, send_status, last_updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_message_actions_chat_open
      ON message_actions(group_folder, presentation_chat_jid, send_status, last_updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_message_actions_followup
      ON message_actions(group_folder, followup_at, send_status);
    CREATE TABLE IF NOT EXISTS outcomes (
      outcome_id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_key TEXT NOT NULL,
      linked_refs_json TEXT,
      status TEXT NOT NULL,
      completion_summary TEXT,
      next_followup_text TEXT,
      blocker_text TEXT,
      due_at TEXT,
      review_horizon TEXT NOT NULL,
      last_checked_at TEXT NOT NULL,
      user_confirmed INTEGER NOT NULL DEFAULT 0,
      show_in_daily_review INTEGER NOT NULL DEFAULT 1,
      show_in_weekly_review INTEGER NOT NULL DEFAULT 1,
      review_suppressed_until TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_outcomes_source
      ON outcomes(group_folder, source_type, source_key);
    CREATE INDEX IF NOT EXISTS idx_outcomes_group_updated
      ON outcomes(group_folder, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_outcomes_group_review
      ON outcomes(
        group_folder,
        show_in_daily_review,
        show_in_weekly_review,
        review_horizon,
        updated_at DESC
      );
    CREATE TABLE IF NOT EXISTS life_threads (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      status TEXT NOT NULL,
      scope TEXT NOT NULL,
      related_subject_ids_json TEXT NOT NULL,
      context_tags_json TEXT NOT NULL,
      summary TEXT NOT NULL,
      next_action TEXT,
      next_followup_at TEXT,
      source_kind TEXT NOT NULL,
      confidence_kind TEXT NOT NULL,
      user_confirmed INTEGER NOT NULL DEFAULT 0,
      sensitivity TEXT NOT NULL DEFAULT 'normal',
      surface_mode TEXT NOT NULL DEFAULT 'default',
      followthrough_mode TEXT NOT NULL DEFAULT 'important_only',
      last_surfaced_at TEXT,
      snoozed_until TEXT,
      linked_task_id TEXT,
      merged_into_thread_id TEXT,
      created_at TEXT NOT NULL,
      last_updated_at TEXT NOT NULL,
      last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_life_threads_group_status
      ON life_threads(group_folder, status, last_updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_life_threads_group_followup
      ON life_threads(group_folder, next_followup_at, status);
    CREATE TABLE IF NOT EXISTS life_thread_signals (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      summary_text TEXT NOT NULL,
      chat_jid TEXT,
      message_id TEXT,
      task_id TEXT,
      calendar_event_id TEXT,
      profile_fact_id TEXT,
      confidence_kind TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES life_threads(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_life_thread_signals_thread
      ON life_thread_signals(thread_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_life_thread_signals_group
      ON life_thread_signals(group_folder, created_at DESC);
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS community_skills (
      skill_id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      slug TEXT NOT NULL,
      display_name TEXT NOT NULL,
      source_url TEXT NOT NULL,
      canonical_clawhub_url TEXT,
      github_tree_url TEXT NOT NULL,
      cache_dir_name TEXT NOT NULL UNIQUE,
      cache_path TEXT NOT NULL,
      manifest_path TEXT NOT NULL,
      cached_at TEXT NOT NULL,
      file_count INTEGER NOT NULL,
      virus_total_status TEXT,
      openclaw_status TEXT,
      openclaw_summary TEXT
    );
    CREATE TABLE IF NOT EXISTS group_enabled_skills (
      group_folder TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      enabled_at TEXT NOT NULL,
      PRIMARY KEY (group_folder, skill_id),
      FOREIGN KEY (skill_id) REFERENCES community_skills(skill_id)
    );
    CREATE INDEX IF NOT EXISTS idx_group_enabled_skills_group
      ON group_enabled_skills(group_folder, enabled_at);
    CREATE INDEX IF NOT EXISTS idx_group_enabled_skills_skill
      ON group_enabled_skills(skill_id);
    CREATE TABLE IF NOT EXISTS cursor_agents (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      status TEXT NOT NULL,
      model TEXT,
      prompt_text TEXT NOT NULL,
      source_repository TEXT,
      source_ref TEXT,
      source_pr_url TEXT,
      target_url TEXT,
      target_pr_url TEXT,
      target_branch_name TEXT,
      auto_create_pr INTEGER DEFAULT 0,
      open_as_cursor_github_app INTEGER DEFAULT 0,
      skip_reviewer_request INTEGER DEFAULT 0,
      summary TEXT,
      raw_json TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_synced_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cursor_agents_group_created
      ON cursor_agents(group_folder, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cursor_agents_chat_created
      ON cursor_agents(chat_jid, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cursor_agents_status
      ON cursor_agents(status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS cursor_agent_artifacts (
      agent_id TEXT NOT NULL,
      absolute_path TEXT NOT NULL,
      size_bytes INTEGER,
      updated_at TEXT,
      download_url TEXT,
      download_url_expires_at TEXT,
      synced_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, absolute_path),
      FOREIGN KEY (agent_id) REFERENCES cursor_agents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_cursor_agent_artifacts_agent
      ON cursor_agent_artifacts(agent_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS cursor_agent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      status TEXT,
      summary TEXT,
      webhook_id TEXT,
      payload_json TEXT NOT NULL,
      received_at TEXT NOT NULL,
      FOREIGN KEY (agent_id) REFERENCES cursor_agents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_cursor_agent_events_agent
      ON cursor_agent_events(agent_id, received_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cursor_agent_events_webhook
      ON cursor_agent_events(webhook_id)
      WHERE webhook_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS cursor_operator_contexts (
      chat_jid TEXT NOT NULL,
      thread_id TEXT NOT NULL DEFAULT '',
      selected_lane_id TEXT,
      selected_agent_id TEXT,
      selected_jobs_by_lane_json TEXT,
      last_list_snapshot_json TEXT,
      last_list_message_id TEXT,
      dashboard_message_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (chat_jid, thread_id)
    );
    CREATE TABLE IF NOT EXISTS cursor_message_contexts (
      chat_jid TEXT NOT NULL,
      platform_message_id TEXT NOT NULL,
      thread_id TEXT,
      context_kind TEXT NOT NULL,
      lane_id TEXT,
      agent_id TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (chat_jid, platform_message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_cursor_message_contexts_agent
      ON cursor_message_contexts(agent_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS response_feedback (
      feedback_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      classification TEXT NOT NULL,
      channel TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      thread_id TEXT,
      platform_message_id TEXT,
      user_message_id TEXT,
      issue_id TEXT,
      route_key TEXT,
      capability_id TEXT,
      handler_kind TEXT,
      response_source TEXT,
      trace_reason TEXT,
      trace_notes_json TEXT NOT NULL,
      blocker_class TEXT,
      blocker_owner TEXT NOT NULL,
      original_user_text TEXT NOT NULL,
      assistant_reply_text TEXT NOT NULL,
      linked_refs_json TEXT NOT NULL,
      remediation_lane_id TEXT,
      remediation_job_id TEXT,
      remediation_runtime_preference TEXT,
      remediation_prompt TEXT,
      operator_note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_response_feedback_chat_message
      ON response_feedback(chat_jid, platform_message_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_response_feedback_status_updated
      ON response_feedback(status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS runtime_orchestration_jobs (
      job_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      group_jid TEXT NOT NULL,
      parent_job_id TEXT,
      thread_id TEXT,
      runtime_route TEXT NOT NULL,
      requested_runtime TEXT,
      selected_runtime TEXT,
      status TEXT NOT NULL,
      stop_requested INTEGER DEFAULT 0,
      prompt_preview TEXT NOT NULL,
      latest_output_text TEXT,
      final_output_text TEXT,
      error_text TEXT,
      log_file TEXT,
      source_system TEXT NOT NULL,
      actor_ref TEXT,
      correlation_id TEXT,
      reply_ref TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_orchestration_jobs_created
      ON runtime_orchestration_jobs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runtime_orchestration_jobs_group_created
      ON runtime_orchestration_jobs(group_folder, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runtime_orchestration_jobs_thread_created
      ON runtime_orchestration_jobs(thread_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS purchase_requests (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      requested_by TEXT,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      product_title TEXT NOT NULL,
      product_url TEXT,
      asin TEXT NOT NULL,
      offer_id TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      merchant_name TEXT,
      availability TEXT,
      buying_guidance TEXT,
      currency_code TEXT,
      expected_unit_price REAL,
      expected_total_price REAL,
      approval_code_hash TEXT NOT NULL,
      approval_expires_at TEXT NOT NULL,
      approved_by TEXT,
      approved_at TEXT,
      order_mode TEXT NOT NULL,
      external_order_id TEXT,
      submitted_order_id TEXT,
      submitted_at TEXT,
      completed_at TEXT,
      cancelled_at TEXT,
      failure_reason TEXT,
      raw_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_purchase_requests_group_created
      ON purchase_requests(group_folder, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_purchase_requests_chat_created
      ON purchase_requests(chat_jid, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_purchase_requests_status
      ON purchase_requests(status, updated_at DESC);
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add script column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`);
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE messages ADD COLUMN thread_id TEXT`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_id TEXT`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE cursor_operator_contexts ADD COLUMN selected_lane_id TEXT`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE cursor_operator_contexts ADD COLUMN selected_jobs_by_lane_json TEXT`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE cursor_operator_contexts ADD COLUMN dashboard_message_id TEXT`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE life_threads ADD COLUMN followthrough_mode TEXT DEFAULT 'important_only'`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE life_threads ADD COLUMN last_surfaced_at TEXT`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE life_threads ADD COLUMN snoozed_until TEXT`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE life_threads ADD COLUMN linked_task_id TEXT`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE companion_handoffs ADD COLUMN communication_thread_id TEXT`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE companion_handoffs ADD COLUMN communication_subject_ids_json TEXT`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE companion_handoffs ADD COLUMN communication_life_thread_ids_json TEXT`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE companion_handoffs ADD COLUMN last_communication_summary TEXT`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE companion_handoffs ADD COLUMN mission_id TEXT`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE companion_handoffs ADD COLUMN mission_summary TEXT`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE companion_handoffs ADD COLUMN mission_suggested_actions_json TEXT`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE companion_handoffs ADD COLUMN mission_blockers_json TEXT`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE companion_handoffs ADD COLUMN mission_step_focus_json TEXT`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE action_bundle_actions ADD COLUMN delegation_rule_id TEXT`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE action_bundle_actions ADD COLUMN delegation_mode TEXT`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE action_bundle_actions ADD COLUMN delegation_explanation TEXT`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE message_actions ADD COLUMN scheduled_task_id TEXT`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE message_actions ADD COLUMN approved_at TEXT`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE message_actions ADD COLUMN last_action_kind TEXT`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE message_actions ADD COLUMN last_action_at TEXT`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_message_actions_scheduled_task
        ON message_actions(scheduled_task_id)
    `);
  } catch {
    /* index creation can fail until the migration column exists on very old DBs */
  }

  try {
    database.exec(
      `ALTER TABLE cursor_message_contexts ADD COLUMN lane_id TEXT`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE everyday_list_items ADD COLUMN recurrence_kind TEXT NOT NULL DEFAULT 'none'`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE everyday_list_items ADD COLUMN recurrence_interval INTEGER NOT NULL DEFAULT 1`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE everyday_list_items ADD COLUMN recurrence_days_json TEXT`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE everyday_list_items ADD COLUMN recurrence_day_of_month INTEGER`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE everyday_list_items ADD COLUMN recurrence_anchor_at TEXT`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE everyday_list_items ADD COLUMN recurrence_next_due_at TEXT`,
    );
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 0 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);
  prunePilotLoopData(
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
  );

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
  prunePilotLoopData(
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
  );
}

/** @internal - for tests only. */
export function _closeDatabase(): void {
  db.close();
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
function normalizeChatNameCandidate(value: string | null | undefined): string {
  return (value || '').trim();
}

function isPlaceholderChatName(chatJid: string, name: string | null | undefined): boolean {
  const normalizedName = normalizeChatNameCandidate(name);
  if (!normalizedName) return true;
  const jidSansPrefix = chatJid.replace(/^bb:/i, '');
  if (normalizedName === chatJid || normalizedName === jidSansPrefix) {
    return true;
  }
  return /^(?:bb:)?(?:iMessage|SMS|RCS):[+-];(?:chat[0-9]+|[^ ]+@[^ ]+|\+?\d+)$/i.test(
    normalizedName,
  );
}

export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;
  const normalizedName = normalizeChatNameCandidate(name);
  const safeName =
    normalizedName && !isPlaceholderChatName(chatJid, normalizedName)
      ? normalizedName
      : null;

  if (safeName) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, safeName, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  if (isPlaceholderChatName(chatJid, name)) {
    return;
  }
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, thread_id, reply_to_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.thread_id || null,
    msg.reply_to_id || null,
  );
}

export function hasStoredMessage(chatJid: string, messageId: string): boolean {
  const row = db
    .prepare(
      `
        SELECT 1
        FROM messages
        WHERE chat_jid = ? AND id = ?
        LIMIT 1
      `,
    )
    .get(chatJid, messageId) as { 1: number } | undefined;
  return Boolean(row);
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
  thread_id?: string;
  reply_to_id?: string;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, thread_id, reply_to_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.thread_id || null,
    msg.reply_to_id || null,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, thread_id, reply_to_id
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, thread_id, reply_to_id
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

export function listRecentMessagesForChat(
  chatJid: string,
  limit: number = 20,
): NewMessage[] {
  return db
    .prepare(
      `
        SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, thread_id, reply_to_id
        FROM messages
        WHERE chat_jid = ?
          AND content != '' AND content IS NOT NULL
        ORDER BY timestamp DESC
        LIMIT ?
      `,
    )
    .all(chatJid, Math.max(1, limit)) as NewMessage[];
}

export function listMessagesForChatWindow(params: {
  chatJid: string;
  startTimestamp: string;
  endTimestamp?: string | null;
  limit?: number;
}): NewMessage[] {
  return db
    .prepare(
      `
        SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, thread_id, reply_to_id
        FROM messages
        WHERE chat_jid = ?
          AND timestamp >= ?
          AND (? IS NULL OR timestamp <= ?)
          AND content != '' AND content IS NOT NULL
        ORDER BY timestamp ASC
        LIMIT ?
      `,
    )
    .all(
      params.chatJid,
      params.startTimestamp,
      params.endTimestamp || null,
      params.endTimestamp || null,
      Math.max(1, params.limit ?? 400),
    ) as NewMessage[];
}

export function getLastBotMessageTimestamp(
  chatJid: string,
  botPrefix: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT MAX(timestamp) as ts FROM messages
       WHERE chat_jid = ? AND (is_bot_message = 1 OR content LIKE ?)`,
    )
    .get(chatJid, `${botPrefix}:%`) as { ts: string | null } | undefined;
  return row?.ts ?? undefined;
}

function normalizeCursorContextThreadId(threadId?: string | null): string {
  return threadId?.trim() || '';
}

export function upsertCursorOperatorContext(record: {
  chatJid: string;
  threadId?: string | null;
  selectedLaneId?: string | null;
  selectedAgentId?: string | null;
  selectedJobsByLaneJson?: string | null;
  lastListSnapshotJson?: string | null;
  lastListMessageId?: string | null;
  dashboardMessageId?: string | null;
  updatedAt?: string;
}): void {
  const threadId = normalizeCursorContextThreadId(record.threadId);
  const existing = db
    .prepare(
      `
        SELECT *
        FROM cursor_operator_contexts
        WHERE chat_jid = ? AND thread_id = ?
      `,
    )
    .get(record.chatJid, threadId) as CursorOperatorContextRecord | undefined;

  db.prepare(
    `
      INSERT INTO cursor_operator_contexts (
        chat_jid,
        thread_id,
        selected_lane_id,
        selected_agent_id,
        selected_jobs_by_lane_json,
        last_list_snapshot_json,
        last_list_message_id,
        dashboard_message_id,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_jid, thread_id) DO UPDATE SET
        selected_lane_id = excluded.selected_lane_id,
        selected_agent_id = excluded.selected_agent_id,
        selected_jobs_by_lane_json = excluded.selected_jobs_by_lane_json,
        last_list_snapshot_json = excluded.last_list_snapshot_json,
        last_list_message_id = excluded.last_list_message_id,
        dashboard_message_id = excluded.dashboard_message_id,
        updated_at = excluded.updated_at
    `,
  ).run(
    record.chatJid,
    threadId,
    record.selectedLaneId === undefined
      ? existing?.selected_lane_id || null
      : record.selectedLaneId,
    record.selectedAgentId === undefined
      ? existing?.selected_agent_id || null
      : record.selectedAgentId,
    record.selectedJobsByLaneJson === undefined
      ? existing?.selected_jobs_by_lane_json || null
      : record.selectedJobsByLaneJson,
    record.lastListSnapshotJson === undefined
      ? existing?.last_list_snapshot_json || null
      : record.lastListSnapshotJson,
    record.lastListMessageId === undefined
      ? existing?.last_list_message_id || null
      : record.lastListMessageId,
    record.dashboardMessageId === undefined
      ? existing?.dashboard_message_id || null
      : record.dashboardMessageId,
    record.updatedAt || new Date().toISOString(),
  );
}

export function getCursorOperatorContext(
  chatJid: string,
  threadId?: string | null,
): CursorOperatorContextRecord | undefined {
  return db
    .prepare(
      `
        SELECT *
        FROM cursor_operator_contexts
        WHERE chat_jid = ? AND thread_id = ?
      `,
    )
    .get(chatJid, normalizeCursorContextThreadId(threadId)) as
    | CursorOperatorContextRecord
    | undefined;
}

export function storeCursorMessageContext(record: {
  chatJid: string;
  platformMessageId: string;
  threadId?: string | null;
  contextKind: string;
  laneId?: string | null;
  agentId?: string | null;
  payloadJson?: string | null;
  createdAt?: string;
}): void {
  db.prepare(
    `
      INSERT OR REPLACE INTO cursor_message_contexts (
        chat_jid,
        platform_message_id,
        thread_id,
        context_kind,
        lane_id,
        agent_id,
        payload_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    record.chatJid,
    record.platformMessageId,
    record.threadId || null,
    record.contextKind,
    record.laneId || null,
    record.agentId || null,
    record.payloadJson || null,
    record.createdAt || new Date().toISOString(),
  );
}

export function getCursorMessageContext(
  chatJid: string,
  platformMessageId: string,
): CursorMessageContextRecord | undefined {
  return db
    .prepare(
      `
        SELECT *
        FROM cursor_message_contexts
        WHERE chat_jid = ? AND platform_message_id = ?
      `,
    )
    .get(chatJid, platformMessageId) as CursorMessageContextRecord | undefined;
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.script || null,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'script'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.script !== undefined) {
    fields.push('script = ?');
    values.push(updates.script || null);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM calendar_automations WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function createCalendarAutomation(
  input: Omit<CalendarAutomationRecordInput, 'status' | 'next_run'>,
): void {
  db.prepare(
    `
      INSERT INTO calendar_automations (
        task_id,
        chat_jid,
        group_folder,
        automation_type,
        label,
        config_json,
        dedupe_state_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    input.task_id,
    input.chat_jid,
    input.group_folder,
    input.automation_type,
    input.label,
    input.config_json,
    input.dedupe_state_json,
    input.created_at,
    input.updated_at,
  );
}

export function getCalendarAutomationByTaskId(
  taskId: string,
): CalendarAutomationRecordInput | undefined {
  return db
    .prepare(
      `
        SELECT
          calendar_automations.*,
          scheduled_tasks.status,
          scheduled_tasks.next_run
        FROM calendar_automations
        JOIN scheduled_tasks ON scheduled_tasks.id = calendar_automations.task_id
        WHERE calendar_automations.task_id = ?
      `,
    )
    .get(taskId) as CalendarAutomationRecordInput | undefined;
}

export function listCalendarAutomationsForChat(
  chatJid: string,
): CalendarAutomationRecordInput[] {
  return db
    .prepare(
      `
        SELECT
          calendar_automations.*,
          scheduled_tasks.status,
          scheduled_tasks.next_run
        FROM calendar_automations
        JOIN scheduled_tasks ON scheduled_tasks.id = calendar_automations.task_id
        WHERE calendar_automations.chat_jid = ?
        ORDER BY calendar_automations.updated_at DESC
      `,
    )
    .all(chatJid) as CalendarAutomationRecordInput[];
}

export function updateCalendarAutomation(
  taskId: string,
  updates: Partial<
    Pick<
      CalendarAutomationRecordInput,
      'label' | 'config_json' | 'dedupe_state_json' | 'updated_at'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.label !== undefined) {
    fields.push('label = ?');
    values.push(updates.label);
  }
  if (updates.config_json !== undefined) {
    fields.push('config_json = ?');
    values.push(updates.config_json);
  }
  if (updates.dedupe_state_json !== undefined) {
    fields.push('dedupe_state_json = ?');
    values.push(updates.dedupe_state_json);
  }
  if (updates.updated_at !== undefined) {
    fields.push('updated_at = ?');
    values.push(updates.updated_at);
  }

  if (fields.length === 0) return;

  values.push(taskId);
  db.prepare(
    `UPDATE calendar_automations SET ${fields.join(', ')} WHERE task_id = ?`,
  ).run(...values);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

export function deleteRouterState(key: string): void {
  db.prepare('DELETE FROM router_state WHERE key = ?').run(key);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function deleteSession(groupFolder: string): void {
  assertValidGroupFolder(groupFolder);
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

export function deleteSessionStorageKey(storageKey: string): void {
  if (!storageKey?.trim()) return;
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(storageKey);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

export function getAgentThread(
  groupFolder: string,
): AgentThreadState | undefined {
  const row = db
    .prepare(
      `
        SELECT group_folder, runtime, thread_id, last_response_id, updated_at
        FROM agent_threads
        WHERE group_folder = ?
      `,
    )
    .get(groupFolder) as AgentThreadState | undefined;

  if (row) {
    return row;
  }

  const legacySessionId = getSession(groupFolder);
  if (!legacySessionId) return undefined;

  return {
    group_folder: groupFolder,
    runtime: 'claude_legacy',
    thread_id: legacySessionId,
    last_response_id: null,
    updated_at: '',
  };
}

export function setAgentThread(thread: AgentThreadState): void {
  assertValidGroupFolder(thread.group_folder);
  db.prepare(
    `
      INSERT OR REPLACE INTO agent_threads (
        group_folder,
        runtime,
        thread_id,
        last_response_id,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)
    `,
  ).run(
    thread.group_folder,
    thread.runtime,
    thread.thread_id,
    thread.last_response_id || null,
    thread.updated_at,
  );
  setSession(thread.group_folder, thread.thread_id);
}

export function deleteAgentThread(groupFolder: string): void {
  assertValidGroupFolder(groupFolder);
  db.prepare('DELETE FROM agent_threads WHERE group_folder = ?').run(
    groupFolder,
  );
}

export function getAllAgentThreads(): Record<string, AgentThreadState> {
  const rows = db
    .prepare(
      `
        SELECT group_folder, runtime, thread_id, last_response_id, updated_at
        FROM agent_threads
      `,
    )
    .all() as AgentThreadState[];
  const result: Record<string, AgentThreadState> = {};

  for (const row of rows) {
    result[row.group_folder] = row;
  }

  const legacySessions = getAllSessions();
  for (const [groupFolder, threadId] of Object.entries(legacySessions)) {
    if (result[groupFolder]) continue;
    result[groupFolder] = {
      group_folder: groupFolder,
      runtime: 'claude_legacy',
      thread_id: threadId,
      last_response_id: null,
      updated_at: '',
    };
  }

  return result;
}

interface RuntimeOrchestrationJobRow {
  job_id: string;
  kind: RuntimeOrchestrationJob['kind'];
  status: RuntimeOrchestrationJob['status'];
  stop_requested: number;
  group_folder: string;
  group_jid: string;
  parent_job_id: string | null;
  thread_id: string | null;
  runtime_route: RuntimeOrchestrationJob['runtimeRoute'];
  requested_runtime: RuntimeOrchestrationJob['requestedRuntime'] | null;
  selected_runtime: RuntimeOrchestrationJob['selectedRuntime'] | null;
  prompt_preview: string;
  latest_output_text: string | null;
  final_output_text: string | null;
  error_text: string | null;
  log_file: string | null;
  source_system: string;
  actor_ref: string | null;
  correlation_id: string | null;
  reply_ref: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface RuntimeOrchestrationJobRecord extends RuntimeOrchestrationJob {
  actorRef?: string | null;
}

function mapRuntimeOrchestrationJobRow(
  row: RuntimeOrchestrationJobRow,
): RuntimeOrchestrationJobRecord {
  return {
    jobId: row.job_id,
    kind: row.kind,
    status: row.status,
    stopRequested: row.stop_requested === 1,
    groupFolder: row.group_folder,
    groupJid: row.group_jid,
    parentJobId: row.parent_job_id,
    threadId: row.thread_id,
    runtimeRoute: row.runtime_route,
    requestedRuntime: row.requested_runtime,
    selectedRuntime: row.selected_runtime,
    promptPreview: row.prompt_preview,
    latestOutputText: row.latest_output_text,
    finalOutputText: row.final_output_text,
    errorText: row.error_text,
    logFile: row.log_file,
    sourceSystem: row.source_system,
    actorRef: row.actor_ref,
    correlationId: row.correlation_id,
    replyRef: row.reply_ref,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  };
}

export function createRuntimeOrchestrationJob(
  job: RuntimeOrchestrationJobRecord,
): void {
  assertValidGroupFolder(job.groupFolder);
  db.prepare(
    `
      INSERT INTO runtime_orchestration_jobs (
        job_id,
        kind,
        group_folder,
        group_jid,
        parent_job_id,
        thread_id,
        runtime_route,
        requested_runtime,
        selected_runtime,
        status,
        stop_requested,
        prompt_preview,
        latest_output_text,
        final_output_text,
        error_text,
        log_file,
        source_system,
        actor_ref,
        correlation_id,
        reply_ref,
        created_at,
        started_at,
        finished_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    job.jobId,
    job.kind,
    job.groupFolder,
    job.groupJid,
    job.parentJobId || null,
    job.threadId || null,
    job.runtimeRoute,
    job.requestedRuntime || null,
    job.selectedRuntime || null,
    job.status,
    job.stopRequested ? 1 : 0,
    job.promptPreview,
    job.latestOutputText || null,
    job.finalOutputText || null,
    job.errorText || null,
    job.logFile || null,
    job.sourceSystem,
    job.actorRef || null,
    job.correlationId || null,
    job.replyRef || null,
    job.createdAt,
    job.startedAt || null,
    job.finishedAt || null,
    job.updatedAt,
  );
}

export function updateRuntimeOrchestrationJob(
  jobId: string,
  updates: Partial<RuntimeOrchestrationJobRecord>,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  const addField = (field: string, value: unknown): void => {
    fields.push(`${field} = ?`);
    values.push(value);
  };

  if (updates.threadId !== undefined) addField('thread_id', updates.threadId);
  if (updates.requestedRuntime !== undefined) {
    addField('requested_runtime', updates.requestedRuntime);
  }
  if (updates.selectedRuntime !== undefined) {
    addField('selected_runtime', updates.selectedRuntime);
  }
  if (updates.status !== undefined) addField('status', updates.status);
  if (updates.stopRequested !== undefined) {
    addField('stop_requested', updates.stopRequested ? 1 : 0);
  }
  if (updates.latestOutputText !== undefined) {
    addField('latest_output_text', updates.latestOutputText);
  }
  if (updates.finalOutputText !== undefined) {
    addField('final_output_text', updates.finalOutputText);
  }
  if (updates.errorText !== undefined)
    addField('error_text', updates.errorText);
  if (updates.logFile !== undefined) addField('log_file', updates.logFile);
  if (updates.correlationId !== undefined) {
    addField('correlation_id', updates.correlationId);
  }
  if (updates.replyRef !== undefined) addField('reply_ref', updates.replyRef);
  if (updates.startedAt !== undefined)
    addField('started_at', updates.startedAt);
  if (updates.finishedAt !== undefined) {
    addField('finished_at', updates.finishedAt);
  }
  if (updates.updatedAt !== undefined)
    addField('updated_at', updates.updatedAt);

  if (fields.length === 0) return;

  values.push(jobId);
  db.prepare(
    `UPDATE runtime_orchestration_jobs SET ${fields.join(', ')} WHERE job_id = ?`,
  ).run(...values);
}

export function getRuntimeOrchestrationJob(
  jobId: string,
): RuntimeOrchestrationJobRecord | undefined {
  const row = db
    .prepare(
      `
        SELECT *
        FROM runtime_orchestration_jobs
        WHERE job_id = ?
      `,
    )
    .get(jobId) as RuntimeOrchestrationJobRow | undefined;

  return row ? mapRuntimeOrchestrationJobRow(row) : undefined;
}

export function listRuntimeOrchestrationJobs(
  query: ListRuntimeJobsRequest = {},
): RuntimeOrchestrationJobList {
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (query.groupFolder) {
    assertValidGroupFolder(query.groupFolder);
    conditions.push('group_folder = ?');
    values.push(query.groupFolder);
  }

  if (query.threadId) {
    conditions.push('thread_id = ?');
    values.push(query.threadId);
  }

  if (query.beforeJobId) {
    const anchor = getRuntimeOrchestrationJob(query.beforeJobId);
    if (anchor) {
      conditions.push('(created_at < ? OR (created_at = ? AND job_id < ?))');
      values.push(anchor.createdAt, anchor.createdAt, anchor.jobId);
    }
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db
    .prepare(
      `
        SELECT *
        FROM runtime_orchestration_jobs
        ${whereClause}
        ORDER BY created_at DESC, job_id DESC
        LIMIT ?
      `,
    )
    .all(...values, limit + 1) as RuntimeOrchestrationJobRow[];

  const hasMore = rows.length > limit;
  const visibleRows = hasMore ? rows.slice(0, limit) : rows;
  const jobs = visibleRows.map(mapRuntimeOrchestrationJobRow);

  return {
    jobs,
    nextBeforeJobId: hasMore ? jobs.at(-1)?.jobId || null : null,
  };
}

export function findLatestRuntimeJobByThread(
  threadId: string,
): RuntimeOrchestrationJobRecord | undefined {
  const row = db
    .prepare(
      `
        SELECT *
        FROM runtime_orchestration_jobs
        WHERE thread_id = ?
        ORDER BY created_at DESC, job_id DESC
        LIMIT 1
      `,
    )
    .get(threadId) as RuntimeOrchestrationJobRow | undefined;

  return row ? mapRuntimeOrchestrationJobRow(row) : undefined;
}

export function upsertRuntimeBackendJob(
  record: RuntimeBackendJobCacheRecord,
): void {
  assertValidGroupFolder(record.group_folder);
  db.prepare(
    `
      INSERT INTO runtime_backend_jobs (
        backend_id,
        job_id,
        group_folder,
        chat_jid,
        thread_id,
        status,
        selected_runtime,
        prompt_preview,
        latest_output_text,
        error_text,
        log_file,
        created_at,
        updated_at,
        raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(backend_id, job_id) DO UPDATE SET
        group_folder = excluded.group_folder,
        chat_jid = excluded.chat_jid,
        thread_id = excluded.thread_id,
        status = excluded.status,
        selected_runtime = excluded.selected_runtime,
        prompt_preview = excluded.prompt_preview,
        latest_output_text = excluded.latest_output_text,
        error_text = excluded.error_text,
        log_file = excluded.log_file,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        raw_json = excluded.raw_json
    `,
  ).run(
    record.backend_id,
    record.job_id,
    record.group_folder,
    record.chat_jid,
    record.thread_id,
    record.status,
    record.selected_runtime,
    record.prompt_preview,
    record.latest_output_text,
    record.error_text,
    record.log_file,
    record.created_at,
    record.updated_at,
    record.raw_json,
  );
}

export function getRuntimeBackendJob(
  backendId: string,
  jobId: string,
): RuntimeBackendJobCacheRecord | undefined {
  return db
    .prepare(
      `
        SELECT
          backend_id,
          job_id,
          group_folder,
          chat_jid,
          thread_id,
          status,
          selected_runtime,
          prompt_preview,
          latest_output_text,
          error_text,
          log_file,
          created_at,
          updated_at,
          raw_json
        FROM runtime_backend_jobs
        WHERE backend_id = ? AND job_id = ?
      `,
    )
    .get(backendId, jobId) as RuntimeBackendJobCacheRecord | undefined;
}

export function listRuntimeBackendJobsForGroup(
  backendId: string,
  groupFolder: string,
  limit = 20,
): RuntimeBackendJobCacheRecord[] {
  assertValidGroupFolder(groupFolder);
  return db
    .prepare(
      `
        SELECT
          backend_id,
          job_id,
          group_folder,
          chat_jid,
          thread_id,
          status,
          selected_runtime,
          prompt_preview,
          latest_output_text,
          error_text,
          log_file,
          created_at,
          updated_at,
          raw_json
        FROM runtime_backend_jobs
        WHERE backend_id = ? AND group_folder = ?
        ORDER BY created_at DESC, job_id DESC
        LIMIT ?
      `,
    )
    .all(backendId, groupFolder, limit) as RuntimeBackendJobCacheRecord[];
}

export function upsertRuntimeBackendCardContext(
  record: RuntimeBackendCardContextRecord,
): void {
  assertValidGroupFolder(record.group_folder);
  db.prepare(
    `
      INSERT INTO runtime_backend_card_contexts (
        backend_id,
        chat_jid,
        message_id,
        job_id,
        group_folder,
        thread_id,
        created_at,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(backend_id, chat_jid, message_id) DO UPDATE SET
        job_id = excluded.job_id,
        group_folder = excluded.group_folder,
        thread_id = excluded.thread_id,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at
    `,
  ).run(
    record.backend_id,
    record.chat_jid,
    record.message_id,
    record.job_id,
    record.group_folder,
    record.thread_id,
    record.created_at,
    record.expires_at,
  );
}

export function getRuntimeBackendCardContext(
  backendId: string,
  chatJid: string,
  messageId: string,
): RuntimeBackendCardContextRecord | undefined {
  return db
    .prepare(
      `
        SELECT
          backend_id,
          chat_jid,
          message_id,
          job_id,
          group_folder,
          thread_id,
          created_at,
          expires_at
        FROM runtime_backend_card_contexts
        WHERE backend_id = ? AND chat_jid = ? AND message_id = ?
      `,
    )
    .get(backendId, chatJid, messageId) as
    | RuntimeBackendCardContextRecord
    | undefined;
}

export function deleteRuntimeBackendCardContext(
  backendId: string,
  chatJid: string,
  messageId: string,
): void {
  db.prepare(
    `
      DELETE FROM runtime_backend_card_contexts
      WHERE backend_id = ? AND chat_jid = ? AND message_id = ?
    `,
  ).run(backendId, chatJid, messageId);
}

export function pruneExpiredRuntimeBackendCardContexts(nowIso: string): number {
  const result = db
    .prepare(
      `
        DELETE FROM runtime_backend_card_contexts
        WHERE expires_at <= ?
      `,
    )
    .run(nowIso);
  return result.changes;
}

export function upsertRuntimeBackendChatSelection(
  record: RuntimeBackendChatSelectionRecord,
): void {
  assertValidGroupFolder(record.group_folder);
  db.prepare(
    `
      INSERT INTO runtime_backend_chat_selection (
        backend_id,
        chat_jid,
        job_id,
        group_folder,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(backend_id, chat_jid) DO UPDATE SET
        job_id = excluded.job_id,
        group_folder = excluded.group_folder,
        updated_at = excluded.updated_at
    `,
  ).run(
    record.backend_id,
    record.chat_jid,
    record.job_id,
    record.group_folder,
    record.updated_at,
  );
}

export function getRuntimeBackendChatSelection(
  backendId: string,
  chatJid: string,
): RuntimeBackendChatSelectionRecord | undefined {
  return db
    .prepare(
      `
        SELECT
          backend_id,
          chat_jid,
          job_id,
          group_folder,
          updated_at
        FROM runtime_backend_chat_selection
        WHERE backend_id = ? AND chat_jid = ?
      `,
    )
    .get(backendId, chatJid) as RuntimeBackendChatSelectionRecord | undefined;
}

export function deleteRuntimeBackendChatSelection(
  backendId: string,
  chatJid: string,
): void {
  db.prepare(
    `
      DELETE FROM runtime_backend_chat_selection
      WHERE backend_id = ? AND chat_jid = ?
    `,
  ).run(backendId, chatJid);
}

export function upsertAlexaLinkedAccount(record: AlexaLinkedAccount): void {
  assertValidGroupFolder(record.groupFolder);
  db.prepare(
    `
      INSERT INTO alexa_linked_accounts (
        access_token_hash,
        display_name,
        group_folder,
        allowed_alexa_user_id,
        allowed_alexa_person_id,
        created_at,
        updated_at,
        disabled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(access_token_hash) DO UPDATE SET
        display_name = excluded.display_name,
        group_folder = excluded.group_folder,
        allowed_alexa_user_id = excluded.allowed_alexa_user_id,
        allowed_alexa_person_id = excluded.allowed_alexa_person_id,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        disabled_at = excluded.disabled_at
    `,
  ).run(
    record.accessTokenHash,
    record.displayName,
    record.groupFolder,
    record.allowedAlexaUserId || null,
    record.allowedAlexaPersonId || null,
    record.createdAt,
    record.updatedAt,
    record.disabledAt || null,
  );
}

export function getAlexaLinkedAccountByAccessTokenHash(
  accessTokenHash: string,
): AlexaLinkedAccount | undefined {
  const row = db
    .prepare(
      `
        SELECT *
        FROM alexa_linked_accounts
        WHERE access_token_hash = ? AND disabled_at IS NULL
        LIMIT 1
      `,
    )
    .get(accessTokenHash) as
    | {
        access_token_hash: string;
        display_name: string;
        group_folder: string;
        allowed_alexa_user_id: string | null;
        allowed_alexa_person_id: string | null;
        created_at: string;
        updated_at: string;
        disabled_at: string | null;
      }
    | undefined;

  if (!row) return undefined;
  if (!isValidGroupFolder(row.group_folder)) {
    logger.warn(
      { accessTokenHash, groupFolder: row.group_folder },
      'Skipping Alexa linked account with invalid group folder',
    );
    return undefined;
  }

  return {
    accessTokenHash: row.access_token_hash,
    displayName: row.display_name,
    groupFolder: row.group_folder,
    allowedAlexaUserId: row.allowed_alexa_user_id,
    allowedAlexaPersonId: row.allowed_alexa_person_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    disabledAt: row.disabled_at,
  };
}

export function listAlexaLinkedAccounts(): AlexaLinkedAccount[] {
  const rows = db
    .prepare('SELECT * FROM alexa_linked_accounts')
    .all() as Array<{
    access_token_hash: string;
    display_name: string;
    group_folder: string;
    allowed_alexa_user_id: string | null;
    allowed_alexa_person_id: string | null;
    created_at: string;
    updated_at: string;
    disabled_at: string | null;
  }>;

  return rows
    .filter((row) => {
      if (isValidGroupFolder(row.group_folder)) return true;
      logger.warn(
        {
          accessTokenHash: row.access_token_hash,
          groupFolder: row.group_folder,
        },
        'Skipping Alexa linked account with invalid group folder',
      );
      return false;
    })
    .map((row) => ({
      accessTokenHash: row.access_token_hash,
      displayName: row.display_name,
      groupFolder: row.group_folder,
      allowedAlexaUserId: row.allowed_alexa_user_id,
      allowedAlexaPersonId: row.allowed_alexa_person_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      disabledAt: row.disabled_at,
    }));
}

export function insertAlexaOAuthAuthorizationCode(
  record: AlexaOAuthAuthorizationCodeRecord,
): void {
  assertValidGroupFolder(record.groupFolder);
  db.prepare(
    `
      INSERT INTO alexa_oauth_authorization_codes (
        code_hash,
        client_id,
        redirect_uri,
        scope,
        code_challenge,
        code_challenge_method,
        group_folder,
        display_name,
        created_at,
        expires_at,
        used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    record.codeHash,
    record.clientId,
    record.redirectUri,
    record.scope,
    record.codeChallenge || null,
    record.codeChallengeMethod || null,
    record.groupFolder,
    record.displayName,
    record.createdAt,
    record.expiresAt,
    record.usedAt || null,
  );
}

export function getAlexaOAuthAuthorizationCode(
  codeHash: string,
): AlexaOAuthAuthorizationCodeRecord | undefined {
  const row = db
    .prepare(
      `
        SELECT *
        FROM alexa_oauth_authorization_codes
        WHERE code_hash = ?
        LIMIT 1
      `,
    )
    .get(codeHash) as
    | {
        code_hash: string;
        client_id: string;
        redirect_uri: string;
        scope: string;
        code_challenge: string | null;
        code_challenge_method: 'plain' | 'S256' | null;
        group_folder: string;
        display_name: string;
        created_at: string;
        expires_at: string;
        used_at: string | null;
      }
    | undefined;

  if (!row) return undefined;
  if (!isValidGroupFolder(row.group_folder)) {
    logger.warn(
      { codeHash, groupFolder: row.group_folder },
      'Skipping Alexa OAuth authorization code with invalid group folder',
    );
    return undefined;
  }

  return {
    codeHash: row.code_hash,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    scope: row.scope,
    codeChallenge: row.code_challenge,
    codeChallengeMethod: row.code_challenge_method,
    groupFolder: row.group_folder,
    displayName: row.display_name,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
  };
}

export function consumeAlexaOAuthAuthorizationCode(
  codeHash: string,
  usedAt: string,
  now = new Date().toISOString(),
): boolean {
  const result = db
    .prepare(
      `
        UPDATE alexa_oauth_authorization_codes
        SET used_at = ?
        WHERE code_hash = ?
          AND used_at IS NULL
          AND expires_at > ?
      `,
    )
    .run(usedAt, codeHash, now);
  return result.changes === 1;
}

export function purgeExpiredAlexaOAuthAuthorizationCodes(
  now = new Date().toISOString(),
): number {
  const result = db
    .prepare(
      `
        DELETE FROM alexa_oauth_authorization_codes
        WHERE expires_at <= ?
      `,
    )
    .run(now);
  return result.changes;
}

export function insertAlexaOAuthRefreshToken(
  record: AlexaOAuthRefreshTokenRecord,
): void {
  assertValidGroupFolder(record.groupFolder);
  db.prepare(
    `
      INSERT INTO alexa_oauth_refresh_tokens (
        refresh_token_hash,
        client_id,
        scope,
        group_folder,
        display_name,
        created_at,
        expires_at,
        disabled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    record.refreshTokenHash,
    record.clientId,
    record.scope,
    record.groupFolder,
    record.displayName,
    record.createdAt,
    record.expiresAt,
    record.disabledAt || null,
  );
}

export function getAlexaOAuthRefreshToken(
  refreshTokenHash: string,
): AlexaOAuthRefreshTokenRecord | undefined {
  const row = db
    .prepare(
      `
        SELECT *
        FROM alexa_oauth_refresh_tokens
        WHERE refresh_token_hash = ?
        LIMIT 1
      `,
    )
    .get(refreshTokenHash) as
    | {
        refresh_token_hash: string;
        client_id: string;
        scope: string;
        group_folder: string;
        display_name: string;
        created_at: string;
        expires_at: string;
        disabled_at: string | null;
      }
    | undefined;

  if (!row) return undefined;
  if (!isValidGroupFolder(row.group_folder)) {
    logger.warn(
      { refreshTokenHash, groupFolder: row.group_folder },
      'Skipping Alexa OAuth refresh token with invalid group folder',
    );
    return undefined;
  }

  return {
    refreshTokenHash: row.refresh_token_hash,
    clientId: row.client_id,
    scope: row.scope,
    groupFolder: row.group_folder,
    displayName: row.display_name,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    disabledAt: row.disabled_at,
  };
}

export function disableAlexaOAuthRefreshToken(
  refreshTokenHash: string,
  disabledAt: string,
): boolean {
  const result = db
    .prepare(
      `
        UPDATE alexa_oauth_refresh_tokens
        SET disabled_at = ?
        WHERE refresh_token_hash = ?
          AND disabled_at IS NULL
      `,
    )
    .run(disabledAt, refreshTokenHash);
  return result.changes === 1;
}

export function purgeExpiredAlexaOAuthRefreshTokens(
  now = new Date().toISOString(),
): number {
  const result = db
    .prepare(
      `
        DELETE FROM alexa_oauth_refresh_tokens
        WHERE expires_at <= ?
      `,
    )
    .run(now);
  return result.changes;
}

export function upsertAlexaSession(record: AlexaPendingSession): void {
  db.prepare(
    `
      INSERT INTO alexa_sessions (
        principal_key,
        access_token_hash,
        pending_kind,
        payload_json,
        expires_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(principal_key) DO UPDATE SET
        access_token_hash = excluded.access_token_hash,
        pending_kind = excluded.pending_kind,
        payload_json = excluded.payload_json,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `,
  ).run(
    record.principalKey,
    record.accessTokenHash,
    record.pendingKind,
    record.payloadJson,
    record.expiresAt,
    record.updatedAt,
  );
}

export function getAlexaSession(
  principalKey: string,
  accessTokenHash?: string,
  now = new Date().toISOString(),
): AlexaPendingSession | undefined {
  const row = db
    .prepare(
      `
        SELECT *
        FROM alexa_sessions
        WHERE principal_key = ?
        LIMIT 1
      `,
    )
    .get(principalKey) as
    | {
        principal_key: string;
        access_token_hash: string;
        pending_kind: AlexaPendingSession['pendingKind'];
        payload_json: string;
        expires_at: string;
        updated_at: string;
      }
    | undefined;

  if (!row) return undefined;
  if (row.expires_at <= now) {
    clearAlexaSession(principalKey);
    return undefined;
  }
  if (accessTokenHash && row.access_token_hash !== accessTokenHash) {
    clearAlexaSession(principalKey);
    return undefined;
  }

  return {
    principalKey: row.principal_key,
    accessTokenHash: row.access_token_hash,
    pendingKind: row.pending_kind,
    payloadJson: row.payload_json,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  };
}

export function clearAlexaSession(principalKey: string): void {
  db.prepare('DELETE FROM alexa_sessions WHERE principal_key = ?').run(
    principalKey,
  );
}

export function purgeExpiredAlexaSessions(
  now = new Date().toISOString(),
): number {
  const result = db
    .prepare('DELETE FROM alexa_sessions WHERE expires_at <= ?')
    .run(now);
  return result.changes;
}

export function upsertAlexaConversationContext(
  record: AlexaConversationContext,
): void {
  assertValidGroupFolder(record.groupFolder);
  db.prepare(
    `
      INSERT INTO alexa_conversation_contexts (
        principal_key,
        access_token_hash,
        group_folder,
        flow_key,
        subject_kind,
        subject_json,
        summary_text,
        supported_followups_json,
        style_json,
        created_at,
        expires_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(principal_key) DO UPDATE SET
        access_token_hash = excluded.access_token_hash,
        group_folder = excluded.group_folder,
        flow_key = excluded.flow_key,
        subject_kind = excluded.subject_kind,
        subject_json = excluded.subject_json,
        summary_text = excluded.summary_text,
        supported_followups_json = excluded.supported_followups_json,
        style_json = excluded.style_json,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `,
  ).run(
    record.principalKey,
    record.accessTokenHash,
    record.groupFolder,
    record.flowKey,
    record.subjectKind,
    record.subjectJson,
    record.summaryText,
    record.supportedFollowupsJson,
    record.styleJson,
    record.createdAt,
    record.expiresAt,
    record.updatedAt,
  );
}

export function getAlexaConversationContext(
  principalKey: string,
  accessTokenHash?: string,
  now = new Date().toISOString(),
): AlexaConversationContext | undefined {
  const row = db
    .prepare(
      `
        SELECT *
        FROM alexa_conversation_contexts
        WHERE principal_key = ?
        LIMIT 1
      `,
    )
    .get(principalKey) as
    | {
        principal_key: string;
        access_token_hash: string;
        group_folder: string;
        flow_key: string;
        subject_kind: AlexaConversationContext['subjectKind'];
        subject_json: string;
        summary_text: string;
        supported_followups_json: string;
        style_json: string;
        created_at: string;
        expires_at: string;
        updated_at: string;
      }
    | undefined;

  if (!row) return undefined;
  if (row.expires_at <= now) {
    clearAlexaConversationContext(principalKey);
    return undefined;
  }
  if (accessTokenHash && row.access_token_hash !== accessTokenHash) {
    clearAlexaConversationContext(principalKey);
    return undefined;
  }
  if (!isValidGroupFolder(row.group_folder)) {
    clearAlexaConversationContext(principalKey);
    return undefined;
  }

  return {
    principalKey: row.principal_key,
    accessTokenHash: row.access_token_hash,
    groupFolder: row.group_folder,
    flowKey: row.flow_key,
    subjectKind: row.subject_kind,
    subjectJson: row.subject_json,
    summaryText: row.summary_text,
    supportedFollowupsJson: row.supported_followups_json,
    styleJson: row.style_json,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  };
}

export function clearAlexaConversationContext(principalKey: string): void {
  db.prepare(
    'DELETE FROM alexa_conversation_contexts WHERE principal_key = ?',
  ).run(principalKey);
}

export function purgeExpiredAlexaConversationContexts(
  now = new Date().toISOString(),
): number {
  const result = db
    .prepare('DELETE FROM alexa_conversation_contexts WHERE expires_at <= ?')
    .run(now);
  return result.changes;
}

export function upsertCompanionHandoff(record: CompanionHandoffRecord): void {
  assertValidGroupFolder(record.groupFolder);
  db.prepare(
    `
      INSERT INTO companion_handoffs (
        handoff_id,
        group_folder,
        origin_channel,
        target_channel,
        target_chat_jid,
        capability_id,
        voice_summary,
        rich_payload_json,
        status,
        requires_confirmation,
        thread_id,
        task_id,
        communication_thread_id,
        communication_subject_ids_json,
        communication_life_thread_ids_json,
        last_communication_summary,
        mission_id,
        mission_summary,
        mission_suggested_actions_json,
        mission_blockers_json,
        mission_step_focus_json,
        knowledge_source_ids_json,
        work_ref,
        followup_suggestions_json,
        delivered_message_id,
        error_text,
        created_at,
        expires_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(handoff_id) DO UPDATE SET
        group_folder = excluded.group_folder,
        origin_channel = excluded.origin_channel,
        target_channel = excluded.target_channel,
        target_chat_jid = excluded.target_chat_jid,
        capability_id = excluded.capability_id,
        voice_summary = excluded.voice_summary,
        rich_payload_json = excluded.rich_payload_json,
        status = excluded.status,
        requires_confirmation = excluded.requires_confirmation,
        thread_id = excluded.thread_id,
        task_id = excluded.task_id,
        communication_thread_id = excluded.communication_thread_id,
        communication_subject_ids_json = excluded.communication_subject_ids_json,
        communication_life_thread_ids_json = excluded.communication_life_thread_ids_json,
        last_communication_summary = excluded.last_communication_summary,
        mission_id = excluded.mission_id,
        mission_summary = excluded.mission_summary,
        mission_suggested_actions_json = excluded.mission_suggested_actions_json,
        mission_blockers_json = excluded.mission_blockers_json,
        mission_step_focus_json = excluded.mission_step_focus_json,
        knowledge_source_ids_json = excluded.knowledge_source_ids_json,
        work_ref = excluded.work_ref,
        followup_suggestions_json = excluded.followup_suggestions_json,
        delivered_message_id = excluded.delivered_message_id,
        error_text = excluded.error_text,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `,
  ).run(
    record.handoffId,
    record.groupFolder,
    record.originChannel,
    record.targetChannel,
    record.targetChatJid || null,
    record.capabilityId || null,
    record.voiceSummary,
    record.richPayloadJson,
    record.status,
    record.requiresConfirmation ? 1 : 0,
    record.threadId || null,
    record.taskId || null,
    record.communicationThreadId || null,
    record.communicationSubjectIdsJson || null,
    record.communicationLifeThreadIdsJson || null,
    record.lastCommunicationSummary || null,
    record.missionId || null,
    record.missionSummary || null,
    record.missionSuggestedActionsJson || null,
    record.missionBlockersJson || null,
    record.missionStepFocusJson || null,
    record.knowledgeSourceIdsJson || null,
    record.workRef || null,
    record.followupSuggestionsJson || null,
    record.deliveredMessageId || null,
    record.errorText || null,
    record.createdAt,
    record.expiresAt,
    record.updatedAt,
  );
}

export function getCompanionHandoff(
  handoffId: string,
): CompanionHandoffRecord | undefined {
  const row = db
    .prepare(
      `
        SELECT *
        FROM companion_handoffs
        WHERE handoff_id = ?
        LIMIT 1
      `,
    )
    .get(handoffId) as
    | {
        handoff_id: string;
        group_folder: string;
        origin_channel: CompanionHandoffRecord['originChannel'];
        target_channel: CompanionHandoffRecord['targetChannel'];
        target_chat_jid: string | null;
        capability_id: string | null;
        voice_summary: string;
        rich_payload_json: string;
        status: CompanionHandoffRecord['status'];
        requires_confirmation: number;
        thread_id: string | null;
        task_id: string | null;
        communication_thread_id: string | null;
        communication_subject_ids_json: string | null;
        communication_life_thread_ids_json: string | null;
        last_communication_summary: string | null;
        mission_id: string | null;
        mission_summary: string | null;
        mission_suggested_actions_json: string | null;
        mission_blockers_json: string | null;
        mission_step_focus_json: string | null;
        knowledge_source_ids_json: string | null;
        work_ref: string | null;
        followup_suggestions_json: string | null;
        delivered_message_id: string | null;
        error_text: string | null;
        created_at: string;
        expires_at: string;
        updated_at: string;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.group_folder)) return undefined;
  return {
    handoffId: row.handoff_id,
    groupFolder: row.group_folder,
    originChannel: row.origin_channel,
    targetChannel: row.target_channel,
    targetChatJid: row.target_chat_jid,
    capabilityId: row.capability_id,
    voiceSummary: row.voice_summary,
    richPayloadJson: row.rich_payload_json,
    status: row.status,
    requiresConfirmation: row.requires_confirmation === 1,
    threadId: row.thread_id,
    taskId: row.task_id,
    communicationThreadId: row.communication_thread_id,
    communicationSubjectIdsJson: row.communication_subject_ids_json,
    communicationLifeThreadIdsJson: row.communication_life_thread_ids_json,
    lastCommunicationSummary: row.last_communication_summary,
    missionId: row.mission_id,
    missionSummary: row.mission_summary,
    missionSuggestedActionsJson: row.mission_suggested_actions_json,
    missionBlockersJson: row.mission_blockers_json,
    missionStepFocusJson: row.mission_step_focus_json,
    knowledgeSourceIdsJson: row.knowledge_source_ids_json,
    workRef: row.work_ref,
    followupSuggestionsJson: row.followup_suggestions_json,
    deliveredMessageId: row.delivered_message_id,
    errorText: row.error_text,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  };
}

export function updateCompanionHandoff(
  handoffId: string,
  updates: Partial<
    Pick<
      CompanionHandoffRecord,
      | 'targetChatJid'
      | 'status'
      | 'deliveredMessageId'
      | 'errorText'
      | 'updatedAt'
      | 'expiresAt'
    >
  >,
): void {
  const existing = getCompanionHandoff(handoffId);
  if (!existing) return;
  upsertCompanionHandoff({
    ...existing,
    targetChatJid:
      updates.targetChatJid !== undefined
        ? updates.targetChatJid
        : existing.targetChatJid,
    status: updates.status || existing.status,
    deliveredMessageId:
      updates.deliveredMessageId !== undefined
        ? updates.deliveredMessageId
        : existing.deliveredMessageId,
    errorText:
      updates.errorText !== undefined ? updates.errorText : existing.errorText,
    updatedAt: updates.updatedAt || new Date().toISOString(),
    expiresAt: updates.expiresAt || existing.expiresAt,
  });
}

export function purgeExpiredCompanionHandoffs(
  now = new Date().toISOString(),
): number {
  const result = db
    .prepare(
      `
        UPDATE companion_handoffs
        SET status = 'expired',
            updated_at = ?
        WHERE expires_at <= ?
          AND status IN ('queued', 'failed')
      `,
    )
    .run(now, now);
  return result.changes;
}

export function listCompanionHandoffsForGroup(params: {
  groupFolder: string;
  statuses?: CompanionHandoffRecord['status'][];
  limit?: number;
}): CompanionHandoffRecord[] {
  assertValidGroupFolder(params.groupFolder);
  const clauses = ['group_folder = ?'];
  const args: unknown[] = [params.groupFolder];
  if (params.statuses?.length) {
    clauses.push(`status IN (${params.statuses.map(() => '?').join(', ')})`);
    args.push(...params.statuses);
  }
  args.push(Math.max(1, params.limit || 50));
  const rows = db
    .prepare(
      `
        SELECT handoff_id
        FROM companion_handoffs
        WHERE ${clauses.join(' AND ')}
        ORDER BY updated_at DESC
        LIMIT ?
      `,
    )
    .all(...args) as Array<{ handoff_id: string }>;
  return rows
    .map((row) => getCompanionHandoff(row.handoff_id))
    .filter((record): record is CompanionHandoffRecord => Boolean(record));
}

export function upsertDelegationRule(record: DelegationRuleRecord): void {
  assertValidGroupFolder(record.groupFolder);
  db.prepare(
    `
      INSERT INTO delegation_rules (
        rule_id,
        group_folder,
        title,
        trigger_type,
        trigger_scope,
        conditions_json,
        delegated_actions_json,
        approval_mode,
        status,
        created_at,
        last_used_at,
        times_used,
        times_auto_applied,
        times_overridden,
        last_outcome_status,
        user_confirmed,
        channel_applicability_json,
        safety_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(rule_id) DO UPDATE SET
        group_folder = excluded.group_folder,
        title = excluded.title,
        trigger_type = excluded.trigger_type,
        trigger_scope = excluded.trigger_scope,
        conditions_json = excluded.conditions_json,
        delegated_actions_json = excluded.delegated_actions_json,
        approval_mode = excluded.approval_mode,
        status = excluded.status,
        created_at = excluded.created_at,
        last_used_at = excluded.last_used_at,
        times_used = excluded.times_used,
        times_auto_applied = excluded.times_auto_applied,
        times_overridden = excluded.times_overridden,
        last_outcome_status = excluded.last_outcome_status,
        user_confirmed = excluded.user_confirmed,
        channel_applicability_json = excluded.channel_applicability_json,
        safety_level = excluded.safety_level
    `,
  ).run(
    record.ruleId,
    record.groupFolder,
    record.title,
    record.triggerType,
    record.triggerScope,
    record.conditionsJson,
    record.delegatedActionsJson,
    record.approvalMode,
    record.status,
    record.createdAt,
    record.lastUsedAt || null,
    record.timesUsed,
    record.timesAutoApplied,
    record.timesOverridden,
    record.lastOutcomeStatus || null,
    record.userConfirmed ? 1 : 0,
    record.channelApplicabilityJson,
    record.safetyLevel,
  );
}

function mapDelegationRuleRow(row: {
  rule_id: string;
  group_folder: string;
  title: string;
  trigger_type: DelegationRuleRecord['triggerType'];
  trigger_scope: DelegationRuleRecord['triggerScope'];
  conditions_json: string;
  delegated_actions_json: string;
  approval_mode: DelegationRuleRecord['approvalMode'];
  status: DelegationRuleRecord['status'];
  created_at: string;
  last_used_at: string | null;
  times_used: number;
  times_auto_applied: number;
  times_overridden: number;
  last_outcome_status: DelegationRuleRecord['lastOutcomeStatus'];
  user_confirmed: number;
  channel_applicability_json: string;
  safety_level: DelegationRuleRecord['safetyLevel'];
}): DelegationRuleRecord {
  return {
    ruleId: row.rule_id,
    groupFolder: row.group_folder,
    title: row.title,
    triggerType: row.trigger_type,
    triggerScope: row.trigger_scope,
    conditionsJson: row.conditions_json,
    delegatedActionsJson: row.delegated_actions_json,
    approvalMode: row.approval_mode,
    status: row.status,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    timesUsed: row.times_used,
    timesAutoApplied: row.times_auto_applied,
    timesOverridden: row.times_overridden,
    lastOutcomeStatus: row.last_outcome_status,
    userConfirmed: row.user_confirmed === 1,
    channelApplicabilityJson: row.channel_applicability_json,
    safetyLevel: row.safety_level,
  };
}

export function getDelegationRule(
  ruleId: string,
): DelegationRuleRecord | undefined {
  const row = db
    .prepare(
      `
        SELECT *
        FROM delegation_rules
        WHERE rule_id = ?
        LIMIT 1
      `,
    )
    .get(ruleId) as
    | {
        rule_id: string;
        group_folder: string;
        title: string;
        trigger_type: DelegationRuleRecord['triggerType'];
        trigger_scope: DelegationRuleRecord['triggerScope'];
        conditions_json: string;
        delegated_actions_json: string;
        approval_mode: DelegationRuleRecord['approvalMode'];
        status: DelegationRuleRecord['status'];
        created_at: string;
        last_used_at: string | null;
        times_used: number;
        times_auto_applied: number;
        times_overridden: number;
        last_outcome_status: DelegationRuleRecord['lastOutcomeStatus'];
        user_confirmed: number;
        channel_applicability_json: string;
        safety_level: DelegationRuleRecord['safetyLevel'];
      }
    | undefined;
  if (!row || !isValidGroupFolder(row.group_folder)) return undefined;
  return mapDelegationRuleRow(row);
}

export function listDelegationRulesForGroup(params: {
  groupFolder: string;
  statuses?: DelegationRuleRecord['status'][];
  limit?: number;
}): DelegationRuleRecord[] {
  assertValidGroupFolder(params.groupFolder);
  const clauses = ['group_folder = ?'];
  const args: unknown[] = [params.groupFolder];
  if (params.statuses?.length) {
    clauses.push(`status IN (${params.statuses.map(() => '?').join(', ')})`);
    args.push(...params.statuses);
  }
  args.push(Math.max(1, params.limit || 100));
  const rows = db
    .prepare(
      `
        SELECT *
        FROM delegation_rules
        WHERE ${clauses.join(' AND ')}
        ORDER BY
          CASE status
            WHEN 'active' THEN 0
            WHEN 'paused' THEN 1
            ELSE 2
          END,
          COALESCE(last_used_at, created_at) DESC
        LIMIT ?
      `,
    )
    .all(...args) as Array<{
      rule_id: string;
      group_folder: string;
      title: string;
      trigger_type: DelegationRuleRecord['triggerType'];
      trigger_scope: DelegationRuleRecord['triggerScope'];
      conditions_json: string;
      delegated_actions_json: string;
      approval_mode: DelegationRuleRecord['approvalMode'];
      status: DelegationRuleRecord['status'];
      created_at: string;
      last_used_at: string | null;
      times_used: number;
      times_auto_applied: number;
      times_overridden: number;
      last_outcome_status: DelegationRuleRecord['lastOutcomeStatus'];
      user_confirmed: number;
      channel_applicability_json: string;
      safety_level: DelegationRuleRecord['safetyLevel'];
    }>;
  return rows
    .filter((row) => isValidGroupFolder(row.group_folder))
    .map((row) => mapDelegationRuleRow(row));
}

export function updateDelegationRule(
  ruleId: string,
  updates: Partial<
    Pick<
      DelegationRuleRecord,
      | 'title'
      | 'conditionsJson'
      | 'delegatedActionsJson'
      | 'approvalMode'
      | 'status'
      | 'lastUsedAt'
      | 'timesUsed'
      | 'timesAutoApplied'
      | 'timesOverridden'
      | 'lastOutcomeStatus'
      | 'userConfirmed'
      | 'channelApplicabilityJson'
      | 'safetyLevel'
    >
  >,
): void {
  const existing = getDelegationRule(ruleId);
  if (!existing) return;
  upsertDelegationRule({
    ...existing,
    title: updates.title ?? existing.title,
    conditionsJson: updates.conditionsJson ?? existing.conditionsJson,
    delegatedActionsJson:
      updates.delegatedActionsJson ?? existing.delegatedActionsJson,
    approvalMode: updates.approvalMode ?? existing.approvalMode,
    status: updates.status ?? existing.status,
    lastUsedAt:
      updates.lastUsedAt !== undefined ? updates.lastUsedAt : existing.lastUsedAt,
    timesUsed: updates.timesUsed ?? existing.timesUsed,
    timesAutoApplied: updates.timesAutoApplied ?? existing.timesAutoApplied,
    timesOverridden: updates.timesOverridden ?? existing.timesOverridden,
    lastOutcomeStatus:
      updates.lastOutcomeStatus !== undefined
        ? updates.lastOutcomeStatus
        : existing.lastOutcomeStatus,
    userConfirmed:
      updates.userConfirmed !== undefined
        ? updates.userConfirmed
        : existing.userConfirmed,
    channelApplicabilityJson:
      updates.channelApplicabilityJson ?? existing.channelApplicabilityJson,
    safetyLevel: updates.safetyLevel ?? existing.safetyLevel,
  });
}

export function upsertMessageAction(record: MessageActionRecord): void {
  assertValidGroupFolder(record.groupFolder);
  db.prepare(
    `
      INSERT INTO message_actions (
        message_action_id,
        group_folder,
        source_type,
        source_key,
        source_summary,
        target_kind,
        target_channel,
        target_conversation_json,
        draft_text,
        trust_level,
        send_status,
        followup_at,
        requires_approval,
        delegation_rule_id,
        delegation_mode,
        explanation_json,
        linked_refs_json,
        platform_message_id,
        scheduled_task_id,
        approved_at,
        last_action_kind,
        last_action_at,
        dedupe_key,
        presentation_chat_jid,
        presentation_thread_id,
        presentation_message_id,
        created_at,
        last_updated_at,
        sent_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_action_id) DO UPDATE SET
        group_folder = excluded.group_folder,
        source_type = excluded.source_type,
        source_key = excluded.source_key,
        source_summary = excluded.source_summary,
        target_kind = excluded.target_kind,
        target_channel = excluded.target_channel,
        target_conversation_json = excluded.target_conversation_json,
        draft_text = excluded.draft_text,
        trust_level = excluded.trust_level,
        send_status = excluded.send_status,
        followup_at = excluded.followup_at,
        requires_approval = excluded.requires_approval,
        delegation_rule_id = excluded.delegation_rule_id,
        delegation_mode = excluded.delegation_mode,
        explanation_json = excluded.explanation_json,
        linked_refs_json = excluded.linked_refs_json,
        platform_message_id = excluded.platform_message_id,
        scheduled_task_id = excluded.scheduled_task_id,
        approved_at = excluded.approved_at,
        last_action_kind = excluded.last_action_kind,
        last_action_at = excluded.last_action_at,
        dedupe_key = excluded.dedupe_key,
        presentation_chat_jid = excluded.presentation_chat_jid,
        presentation_thread_id = excluded.presentation_thread_id,
        presentation_message_id = excluded.presentation_message_id,
        created_at = excluded.created_at,
        last_updated_at = excluded.last_updated_at,
        sent_at = excluded.sent_at
    `,
  ).run(
    record.messageActionId,
    record.groupFolder,
    record.sourceType,
    record.sourceKey,
    record.sourceSummary || null,
    record.targetKind,
    record.targetChannel,
    record.targetConversationJson,
    record.draftText,
    record.trustLevel,
    record.sendStatus,
    record.followupAt || null,
    record.requiresApproval ? 1 : 0,
    record.delegationRuleId || null,
    record.delegationMode || null,
    record.explanationJson || null,
    record.linkedRefsJson || null,
    record.platformMessageId || null,
    record.scheduledTaskId || null,
    record.approvedAt || null,
    record.lastActionKind || null,
    record.lastActionAt || null,
    record.dedupeKey,
    record.presentationChatJid || null,
    record.presentationThreadId || null,
    record.presentationMessageId || null,
    record.createdAt,
    record.lastUpdatedAt,
    record.sentAt || null,
  );
}

function mapMessageActionRow(row: {
  message_action_id: string;
  group_folder: string;
  source_type: MessageActionRecord['sourceType'];
  source_key: string;
  source_summary: string | null;
  target_kind: MessageActionRecord['targetKind'];
  target_channel: MessageActionRecord['targetChannel'];
  target_conversation_json: string;
  draft_text: string;
  trust_level: MessageActionRecord['trustLevel'];
  send_status: MessageActionRecord['sendStatus'];
  followup_at: string | null;
  requires_approval: number;
  delegation_rule_id: string | null;
  delegation_mode: MessageActionRecord['delegationMode'];
  explanation_json: string | null;
  linked_refs_json: string | null;
  platform_message_id: string | null;
  scheduled_task_id: string | null;
  approved_at: string | null;
  last_action_kind: MessageActionRecord['lastActionKind'];
  last_action_at: string | null;
  dedupe_key: string;
  presentation_chat_jid: string | null;
  presentation_thread_id: string | null;
  presentation_message_id: string | null;
  created_at: string;
  last_updated_at: string;
  sent_at: string | null;
}): MessageActionRecord {
  return {
    messageActionId: row.message_action_id,
    groupFolder: row.group_folder,
    sourceType: row.source_type,
    sourceKey: row.source_key,
    sourceSummary: row.source_summary,
    targetKind: row.target_kind,
    targetChannel: row.target_channel,
    targetConversationJson: row.target_conversation_json,
    draftText: row.draft_text,
    trustLevel: row.trust_level,
    sendStatus: row.send_status,
    followupAt: row.followup_at,
    requiresApproval: row.requires_approval === 1,
    delegationRuleId: row.delegation_rule_id,
    delegationMode: row.delegation_mode,
    explanationJson: row.explanation_json,
    linkedRefsJson: row.linked_refs_json,
    platformMessageId: row.platform_message_id,
    scheduledTaskId: row.scheduled_task_id,
    approvedAt: row.approved_at,
    lastActionKind: row.last_action_kind,
    lastActionAt: row.last_action_at,
    dedupeKey: row.dedupe_key,
    presentationChatJid: row.presentation_chat_jid,
    presentationThreadId: row.presentation_thread_id,
    presentationMessageId: row.presentation_message_id,
    createdAt: row.created_at,
    lastUpdatedAt: row.last_updated_at,
    sentAt: row.sent_at,
  };
}

export function getMessageAction(
  messageActionId: string,
): MessageActionRecord | undefined {
  const row = db
    .prepare(
      `
        SELECT *
        FROM message_actions
        WHERE message_action_id = ?
        LIMIT 1
      `,
    )
    .get(messageActionId) as
    | {
        message_action_id: string;
        group_folder: string;
        source_type: MessageActionRecord['sourceType'];
        source_key: string;
        source_summary: string | null;
        target_kind: MessageActionRecord['targetKind'];
        target_channel: MessageActionRecord['targetChannel'];
        target_conversation_json: string;
        draft_text: string;
        trust_level: MessageActionRecord['trustLevel'];
        send_status: MessageActionRecord['sendStatus'];
        followup_at: string | null;
        requires_approval: number;
        delegation_rule_id: string | null;
        delegation_mode: MessageActionRecord['delegationMode'];
        explanation_json: string | null;
        linked_refs_json: string | null;
        platform_message_id: string | null;
        scheduled_task_id: string | null;
        approved_at: string | null;
        last_action_kind: MessageActionRecord['lastActionKind'];
        last_action_at: string | null;
        dedupe_key: string;
        presentation_chat_jid: string | null;
        presentation_thread_id: string | null;
        presentation_message_id: string | null;
        created_at: string;
        last_updated_at: string;
        sent_at: string | null;
      }
    | undefined;
  if (!row || !isValidGroupFolder(row.group_folder)) return undefined;
  return mapMessageActionRow(row);
}

export function getMessageActionBySource(
  groupFolder: string,
  sourceType: MessageActionRecord['sourceType'],
  sourceKey: string,
): MessageActionRecord | undefined {
  assertValidGroupFolder(groupFolder);
  const row = db
    .prepare(
      `
        SELECT *
        FROM message_actions
        WHERE group_folder = ?
          AND source_type = ?
          AND source_key = ?
        ORDER BY last_updated_at DESC
        LIMIT 1
      `,
    )
    .get(groupFolder, sourceType, sourceKey) as
    | {
        message_action_id: string;
        group_folder: string;
        source_type: MessageActionRecord['sourceType'];
        source_key: string;
        source_summary: string | null;
        target_kind: MessageActionRecord['targetKind'];
        target_channel: MessageActionRecord['targetChannel'];
        target_conversation_json: string;
        draft_text: string;
        trust_level: MessageActionRecord['trustLevel'];
        send_status: MessageActionRecord['sendStatus'];
        followup_at: string | null;
        requires_approval: number;
        delegation_rule_id: string | null;
        delegation_mode: MessageActionRecord['delegationMode'];
        explanation_json: string | null;
        linked_refs_json: string | null;
        platform_message_id: string | null;
        scheduled_task_id: string | null;
        approved_at: string | null;
        last_action_kind: MessageActionRecord['lastActionKind'];
        last_action_at: string | null;
        dedupe_key: string;
        presentation_chat_jid: string | null;
        presentation_thread_id: string | null;
        presentation_message_id: string | null;
        created_at: string;
        last_updated_at: string;
        sent_at: string | null;
      }
    | undefined;
  if (!row || !isValidGroupFolder(row.group_folder)) return undefined;
  return mapMessageActionRow(row);
}

export function listMessageActionsForGroup(params: {
  groupFolder: string;
  statuses?: MessageActionRecord['sendStatus'][];
  targetChannels?: MessageActionRecord['targetChannel'][];
  includeSent?: boolean;
  limit?: number;
}): MessageActionRecord[] {
  assertValidGroupFolder(params.groupFolder);
  const clauses = ['group_folder = ?'];
  const args: unknown[] = [params.groupFolder];
  if (params.statuses?.length) {
    clauses.push(`send_status IN (${params.statuses.map(() => '?').join(', ')})`);
    args.push(...params.statuses);
  } else if (!params.includeSent) {
    clauses.push(`send_status != 'sent'`);
  }
  if (params.targetChannels?.length) {
    clauses.push(
      `target_channel IN (${params.targetChannels.map(() => '?').join(', ')})`,
    );
    args.push(...params.targetChannels);
  }
  args.push(Math.max(1, params.limit || 100));
  const rows = db
    .prepare(
      `
        SELECT *
        FROM message_actions
        WHERE ${clauses.join(' AND ')}
        ORDER BY last_updated_at DESC
        LIMIT ?
      `,
    )
    .all(...args) as Array<{
      message_action_id: string;
      group_folder: string;
      source_type: MessageActionRecord['sourceType'];
      source_key: string;
      source_summary: string | null;
      target_kind: MessageActionRecord['targetKind'];
      target_channel: MessageActionRecord['targetChannel'];
      target_conversation_json: string;
      draft_text: string;
      trust_level: MessageActionRecord['trustLevel'];
      send_status: MessageActionRecord['sendStatus'];
      followup_at: string | null;
      requires_approval: number;
      delegation_rule_id: string | null;
      delegation_mode: MessageActionRecord['delegationMode'];
      explanation_json: string | null;
      linked_refs_json: string | null;
      platform_message_id: string | null;
      scheduled_task_id: string | null;
      approved_at: string | null;
      last_action_kind: MessageActionRecord['lastActionKind'];
      last_action_at: string | null;
      dedupe_key: string;
      presentation_chat_jid: string | null;
      presentation_thread_id: string | null;
      presentation_message_id: string | null;
      created_at: string;
      last_updated_at: string;
      sent_at: string | null;
    }>;
  return rows
    .filter((row) => isValidGroupFolder(row.group_folder))
    .map((row) => mapMessageActionRow(row));
}

export function findLatestOpenMessageActionForChat(params: {
  groupFolder: string;
  chatJid: string;
  statuses?: MessageActionRecord['sendStatus'][];
}): MessageActionRecord | undefined {
  assertValidGroupFolder(params.groupFolder);
  const statuses =
    params.statuses && params.statuses.length > 0
      ? params.statuses
      : ['drafted', 'approved', 'deferred', 'failed'];
  const row = db
    .prepare(
      `
        SELECT *
        FROM message_actions
        WHERE group_folder = ?
          AND presentation_chat_jid = ?
          AND send_status IN (${statuses.map(() => '?').join(', ')})
        ORDER BY last_updated_at DESC
        LIMIT 1
      `,
    )
    .get(
      params.groupFolder,
      params.chatJid,
      ...statuses,
    ) as
    | {
        message_action_id: string;
        group_folder: string;
        source_type: MessageActionRecord['sourceType'];
        source_key: string;
        source_summary: string | null;
        target_kind: MessageActionRecord['targetKind'];
        target_channel: MessageActionRecord['targetChannel'];
        target_conversation_json: string;
        draft_text: string;
        trust_level: MessageActionRecord['trustLevel'];
        send_status: MessageActionRecord['sendStatus'];
        followup_at: string | null;
        requires_approval: number;
        delegation_rule_id: string | null;
        delegation_mode: MessageActionRecord['delegationMode'];
        explanation_json: string | null;
        linked_refs_json: string | null;
        platform_message_id: string | null;
        scheduled_task_id: string | null;
        approved_at: string | null;
        last_action_kind: MessageActionRecord['lastActionKind'];
        last_action_at: string | null;
        dedupe_key: string;
        presentation_chat_jid: string | null;
        presentation_thread_id: string | null;
        presentation_message_id: string | null;
        created_at: string;
        last_updated_at: string;
        sent_at: string | null;
      }
    | undefined;
  if (!row || !isValidGroupFolder(row.group_folder)) return undefined;
  return mapMessageActionRow(row);
}

export function getMessageActionByScheduledTaskId(
  scheduledTaskId: string,
): MessageActionRecord | undefined {
  const row = db
    .prepare(
      `
        SELECT *
        FROM message_actions
        WHERE scheduled_task_id = ?
        ORDER BY last_updated_at DESC
        LIMIT 1
      `,
    )
    .get(scheduledTaskId) as
    | {
        message_action_id: string;
        group_folder: string;
        source_type: MessageActionRecord['sourceType'];
        source_key: string;
        source_summary: string | null;
        target_kind: MessageActionRecord['targetKind'];
        target_channel: MessageActionRecord['targetChannel'];
        target_conversation_json: string;
        draft_text: string;
        trust_level: MessageActionRecord['trustLevel'];
        send_status: MessageActionRecord['sendStatus'];
        followup_at: string | null;
        requires_approval: number;
        delegation_rule_id: string | null;
        delegation_mode: MessageActionRecord['delegationMode'];
        explanation_json: string | null;
        linked_refs_json: string | null;
        platform_message_id: string | null;
        scheduled_task_id: string | null;
        approved_at: string | null;
        last_action_kind: MessageActionRecord['lastActionKind'];
        last_action_at: string | null;
        dedupe_key: string;
        presentation_chat_jid: string | null;
        presentation_thread_id: string | null;
        presentation_message_id: string | null;
        created_at: string;
        last_updated_at: string;
        sent_at: string | null;
      }
    | undefined;
  if (!row || !isValidGroupFolder(row.group_folder)) return undefined;
  return mapMessageActionRow(row);
}

export function updateMessageAction(
  messageActionId: string,
  updates: Partial<
    Pick<
      MessageActionRecord,
      | 'sourceSummary'
      | 'targetConversationJson'
      | 'draftText'
      | 'trustLevel'
      | 'sendStatus'
      | 'followupAt'
      | 'requiresApproval'
      | 'delegationRuleId'
      | 'delegationMode'
      | 'explanationJson'
      | 'linkedRefsJson'
      | 'platformMessageId'
      | 'scheduledTaskId'
      | 'approvedAt'
      | 'lastActionKind'
      | 'lastActionAt'
      | 'presentationChatJid'
      | 'presentationThreadId'
      | 'presentationMessageId'
      | 'lastUpdatedAt'
      | 'sentAt'
    >
  >,
): void {
  const existing = getMessageAction(messageActionId);
  if (!existing) return;
  upsertMessageAction({
    ...existing,
    sourceSummary:
      updates.sourceSummary !== undefined
        ? updates.sourceSummary
        : existing.sourceSummary,
    targetConversationJson:
      updates.targetConversationJson ?? existing.targetConversationJson,
    draftText: updates.draftText ?? existing.draftText,
    trustLevel: updates.trustLevel ?? existing.trustLevel,
    sendStatus: updates.sendStatus ?? existing.sendStatus,
    followupAt:
      updates.followupAt !== undefined ? updates.followupAt : existing.followupAt,
    requiresApproval:
      updates.requiresApproval !== undefined
        ? updates.requiresApproval
        : existing.requiresApproval,
    delegationRuleId:
      updates.delegationRuleId !== undefined
        ? updates.delegationRuleId
        : existing.delegationRuleId,
    delegationMode:
      updates.delegationMode !== undefined
        ? updates.delegationMode
        : existing.delegationMode,
    explanationJson:
      updates.explanationJson !== undefined
        ? updates.explanationJson
        : existing.explanationJson,
    linkedRefsJson:
      updates.linkedRefsJson !== undefined
        ? updates.linkedRefsJson
        : existing.linkedRefsJson,
    platformMessageId:
      updates.platformMessageId !== undefined
        ? updates.platformMessageId
        : existing.platformMessageId,
    scheduledTaskId:
      updates.scheduledTaskId !== undefined
        ? updates.scheduledTaskId
        : existing.scheduledTaskId,
    approvedAt:
      updates.approvedAt !== undefined ? updates.approvedAt : existing.approvedAt,
    lastActionKind:
      updates.lastActionKind !== undefined
        ? updates.lastActionKind
        : existing.lastActionKind,
    lastActionAt:
      updates.lastActionAt !== undefined
        ? updates.lastActionAt
        : existing.lastActionAt,
    presentationChatJid:
      updates.presentationChatJid !== undefined
        ? updates.presentationChatJid
        : existing.presentationChatJid,
    presentationThreadId:
      updates.presentationThreadId !== undefined
        ? updates.presentationThreadId
        : existing.presentationThreadId,
    presentationMessageId:
      updates.presentationMessageId !== undefined
        ? updates.presentationMessageId
        : existing.presentationMessageId,
    lastUpdatedAt: updates.lastUpdatedAt ?? new Date().toISOString(),
    sentAt: updates.sentAt !== undefined ? updates.sentAt : existing.sentAt,
  });
}

export function upsertOutcome(record: OutcomeRecord): void {
  assertValidGroupFolder(record.groupFolder);
  db.prepare(
    `
      INSERT INTO outcomes (
        outcome_id,
        group_folder,
        source_type,
        source_key,
        linked_refs_json,
        status,
        completion_summary,
        next_followup_text,
        blocker_text,
        due_at,
        review_horizon,
        last_checked_at,
        user_confirmed,
        show_in_daily_review,
        show_in_weekly_review,
        review_suppressed_until,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(outcome_id) DO UPDATE SET
        group_folder = excluded.group_folder,
        source_type = excluded.source_type,
        source_key = excluded.source_key,
        linked_refs_json = excluded.linked_refs_json,
        status = excluded.status,
        completion_summary = excluded.completion_summary,
        next_followup_text = excluded.next_followup_text,
        blocker_text = excluded.blocker_text,
        due_at = excluded.due_at,
        review_horizon = excluded.review_horizon,
        last_checked_at = excluded.last_checked_at,
        user_confirmed = excluded.user_confirmed,
        show_in_daily_review = excluded.show_in_daily_review,
        show_in_weekly_review = excluded.show_in_weekly_review,
        review_suppressed_until = excluded.review_suppressed_until,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  ).run(
    record.outcomeId,
    record.groupFolder,
    record.sourceType,
    record.sourceKey,
    record.linkedRefsJson || null,
    record.status,
    record.completionSummary || null,
    record.nextFollowupText || null,
    record.blockerText || null,
    record.dueAt || null,
    record.reviewHorizon,
    record.lastCheckedAt,
    record.userConfirmed ? 1 : 0,
    record.showInDailyReview ? 1 : 0,
    record.showInWeeklyReview ? 1 : 0,
    record.reviewSuppressedUntil || null,
    record.createdAt,
    record.updatedAt,
  );
}

function mapOutcomeRow(row: {
  outcome_id: string;
  group_folder: string;
  source_type: OutcomeRecord['sourceType'];
  source_key: string;
  linked_refs_json: string | null;
  status: OutcomeRecord['status'];
  completion_summary: string | null;
  next_followup_text: string | null;
  blocker_text: string | null;
  due_at: string | null;
  review_horizon: OutcomeRecord['reviewHorizon'];
  last_checked_at: string;
  user_confirmed: number;
  show_in_daily_review: number;
  show_in_weekly_review: number;
  review_suppressed_until: string | null;
  created_at: string;
  updated_at: string;
}): OutcomeRecord {
  return {
    outcomeId: row.outcome_id,
    groupFolder: row.group_folder,
    sourceType: row.source_type,
    sourceKey: row.source_key,
    linkedRefsJson: row.linked_refs_json,
    status: row.status,
    completionSummary: row.completion_summary,
    nextFollowupText: row.next_followup_text,
    blockerText: row.blocker_text,
    dueAt: row.due_at,
    reviewHorizon: row.review_horizon,
    lastCheckedAt: row.last_checked_at,
    userConfirmed: row.user_confirmed === 1,
    showInDailyReview: row.show_in_daily_review === 1,
    showInWeeklyReview: row.show_in_weekly_review === 1,
    reviewSuppressedUntil: row.review_suppressed_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getOutcome(outcomeId: string): OutcomeRecord | undefined {
  const row = db
    .prepare(
      `
        SELECT *
        FROM outcomes
        WHERE outcome_id = ?
        LIMIT 1
      `,
    )
    .get(outcomeId) as
    | {
        outcome_id: string;
        group_folder: string;
        source_type: OutcomeRecord['sourceType'];
        source_key: string;
        linked_refs_json: string | null;
        status: OutcomeRecord['status'];
        completion_summary: string | null;
        next_followup_text: string | null;
        blocker_text: string | null;
        due_at: string | null;
        review_horizon: OutcomeRecord['reviewHorizon'];
        last_checked_at: string;
        user_confirmed: number;
        show_in_daily_review: number;
        show_in_weekly_review: number;
        review_suppressed_until: string | null;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  if (!row || !isValidGroupFolder(row.group_folder)) return undefined;
  return mapOutcomeRow(row);
}

export function getOutcomeBySource(
  groupFolder: string,
  sourceType: OutcomeRecord['sourceType'],
  sourceKey: string,
): OutcomeRecord | undefined {
  assertValidGroupFolder(groupFolder);
  const row = db
    .prepare(
      `
        SELECT *
        FROM outcomes
        WHERE group_folder = ?
          AND source_type = ?
          AND source_key = ?
        LIMIT 1
      `,
    )
    .get(groupFolder, sourceType, sourceKey) as
    | {
        outcome_id: string;
        group_folder: string;
        source_type: OutcomeRecord['sourceType'];
        source_key: string;
        linked_refs_json: string | null;
        status: OutcomeRecord['status'];
        completion_summary: string | null;
        next_followup_text: string | null;
        blocker_text: string | null;
        due_at: string | null;
        review_horizon: OutcomeRecord['reviewHorizon'];
        last_checked_at: string;
        user_confirmed: number;
        show_in_daily_review: number;
        show_in_weekly_review: number;
        review_suppressed_until: string | null;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  if (!row || !isValidGroupFolder(row.group_folder)) return undefined;
  return mapOutcomeRow(row);
}

export function listOutcomesForGroup(params: {
  groupFolder: string;
  sourceTypes?: OutcomeRecord['sourceType'][];
  statuses?: OutcomeRecord['status'][];
  includeSuppressed?: boolean;
  limit?: number;
  now?: string;
}): OutcomeRecord[] {
  assertValidGroupFolder(params.groupFolder);
  const clauses = ['group_folder = ?'];
  const args: unknown[] = [params.groupFolder];
  if (params.sourceTypes?.length) {
    clauses.push(`source_type IN (${params.sourceTypes.map(() => '?').join(', ')})`);
    args.push(...params.sourceTypes);
  }
  if (params.statuses?.length) {
    clauses.push(`status IN (${params.statuses.map(() => '?').join(', ')})`);
    args.push(...params.statuses);
  }
  if (!params.includeSuppressed) {
    clauses.push(
      '(review_suppressed_until IS NULL OR review_suppressed_until <= ?)',
    );
    args.push(params.now || new Date().toISOString());
  }
  args.push(Math.max(1, params.limit || 200));
  const rows = db
    .prepare(
      `
        SELECT *
        FROM outcomes
        WHERE ${clauses.join(' AND ')}
        ORDER BY updated_at DESC
        LIMIT ?
      `,
    )
    .all(...args) as Array<{
        outcome_id: string;
        group_folder: string;
        source_type: OutcomeRecord['sourceType'];
        source_key: string;
        linked_refs_json: string | null;
        status: OutcomeRecord['status'];
        completion_summary: string | null;
        next_followup_text: string | null;
        blocker_text: string | null;
        due_at: string | null;
        review_horizon: OutcomeRecord['reviewHorizon'];
        last_checked_at: string;
        user_confirmed: number;
        show_in_daily_review: number;
        show_in_weekly_review: number;
        review_suppressed_until: string | null;
        created_at: string;
        updated_at: string;
      }>;
  return rows
    .filter((row) => isValidGroupFolder(row.group_folder))
    .map((row) => mapOutcomeRow(row));
}

export function updateOutcome(
  outcomeId: string,
  updates: Partial<
    Pick<
      OutcomeRecord,
      | 'linkedRefsJson'
      | 'status'
      | 'completionSummary'
      | 'nextFollowupText'
      | 'blockerText'
      | 'dueAt'
      | 'reviewHorizon'
      | 'lastCheckedAt'
      | 'userConfirmed'
      | 'showInDailyReview'
      | 'showInWeeklyReview'
      | 'reviewSuppressedUntil'
      | 'updatedAt'
    >
  >,
): void {
  const existing = getOutcome(outcomeId);
  if (!existing) return;
  upsertOutcome({
    ...existing,
    linkedRefsJson:
      updates.linkedRefsJson !== undefined
        ? updates.linkedRefsJson
        : existing.linkedRefsJson,
    status: updates.status ?? existing.status,
    completionSummary:
      updates.completionSummary !== undefined
        ? updates.completionSummary
        : existing.completionSummary,
    nextFollowupText:
      updates.nextFollowupText !== undefined
        ? updates.nextFollowupText
        : existing.nextFollowupText,
    blockerText:
      updates.blockerText !== undefined
        ? updates.blockerText
        : existing.blockerText,
    dueAt: updates.dueAt !== undefined ? updates.dueAt : existing.dueAt,
    reviewHorizon: updates.reviewHorizon ?? existing.reviewHorizon,
    lastCheckedAt: updates.lastCheckedAt ?? existing.lastCheckedAt,
    userConfirmed:
      updates.userConfirmed !== undefined
        ? updates.userConfirmed
        : existing.userConfirmed,
    showInDailyReview:
      updates.showInDailyReview !== undefined
        ? updates.showInDailyReview
        : existing.showInDailyReview,
    showInWeeklyReview:
      updates.showInWeeklyReview !== undefined
        ? updates.showInWeeklyReview
        : existing.showInWeeklyReview,
    reviewSuppressedUntil:
      updates.reviewSuppressedUntil !== undefined
        ? updates.reviewSuppressedUntil
        : existing.reviewSuppressedUntil,
    updatedAt: updates.updatedAt ?? new Date().toISOString(),
  });
}

export function upsertActionBundle(record: ActionBundleRecord): void {
  assertValidGroupFolder(record.groupFolder);
  db.prepare(
    `
      INSERT INTO action_bundles (
        bundle_id,
        group_folder,
        title,
        origin_kind,
        origin_capability,
        source_context_key,
        source_context_json,
        presentation_channel,
        presentation_chat_jid,
        presentation_thread_id,
        presentation_message_id,
        presentation_mode,
        bundle_status,
        user_confirmed,
        created_at,
        expires_at,
        last_updated_at,
        related_refs_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(bundle_id) DO UPDATE SET
        group_folder = excluded.group_folder,
        title = excluded.title,
        origin_kind = excluded.origin_kind,
        origin_capability = excluded.origin_capability,
        source_context_key = excluded.source_context_key,
        source_context_json = excluded.source_context_json,
        presentation_channel = excluded.presentation_channel,
        presentation_chat_jid = excluded.presentation_chat_jid,
        presentation_thread_id = excluded.presentation_thread_id,
        presentation_message_id = excluded.presentation_message_id,
        presentation_mode = excluded.presentation_mode,
        bundle_status = excluded.bundle_status,
        user_confirmed = excluded.user_confirmed,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at,
        last_updated_at = excluded.last_updated_at,
        related_refs_json = excluded.related_refs_json
    `,
  ).run(
    record.bundleId,
    record.groupFolder,
    record.title,
    record.originKind,
    record.originCapability || null,
    record.sourceContextKey || null,
    record.sourceContextJson,
    record.presentationChannel,
    record.presentationChatJid || null,
    record.presentationThreadId || null,
    record.presentationMessageId || null,
    record.presentationMode || null,
    record.bundleStatus,
    record.userConfirmed ? 1 : 0,
    record.createdAt,
    record.expiresAt,
    record.lastUpdatedAt,
    record.relatedRefsJson || null,
  );
}

export function replaceActionBundleActions(
  bundleId: string,
  actions: ActionBundleActionRecord[],
): void {
  const tx = db.transaction((nextActions: ActionBundleActionRecord[]) => {
    db.prepare(`DELETE FROM action_bundle_actions WHERE bundle_id = ?`).run(bundleId);
    const insert = db.prepare(
      `
        INSERT INTO action_bundle_actions (
          action_id,
          bundle_id,
          order_index,
          action_type,
          target_system,
          summary,
          requires_confirmation,
          status,
          delegation_rule_id,
          delegation_mode,
          delegation_explanation,
          failure_reason,
          payload_json,
          result_ref_json,
          created_at,
          last_updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );
    for (const action of nextActions) {
      insert.run(
        action.actionId,
        action.bundleId,
        action.orderIndex,
        action.actionType,
        action.targetSystem,
        action.summary,
        action.requiresConfirmation ? 1 : 0,
        action.status,
        action.delegationRuleId || null,
        action.delegationMode || null,
        action.delegationExplanation || null,
        action.failureReason || null,
        action.payloadJson,
        action.resultRefJson || null,
        action.createdAt,
        action.lastUpdatedAt,
      );
    }
  });
  tx(actions);
}

export function getActionBundle(bundleId: string): ActionBundleRecord | undefined {
  const row = db
    .prepare(
      `
        SELECT *
        FROM action_bundles
        WHERE bundle_id = ?
        LIMIT 1
      `,
    )
    .get(bundleId) as
    | {
        bundle_id: string;
        group_folder: string;
        title: string;
        origin_kind: ActionBundleRecord['originKind'];
        origin_capability: string | null;
        source_context_key: string | null;
        source_context_json: string;
        presentation_channel: ActionBundleRecord['presentationChannel'];
        presentation_chat_jid: string | null;
        presentation_thread_id: string | null;
        presentation_message_id: string | null;
        presentation_mode: ActionBundleRecord['presentationMode'] | null;
        bundle_status: ActionBundleRecord['bundleStatus'];
        user_confirmed: number;
        created_at: string;
        expires_at: string;
        last_updated_at: string;
        related_refs_json: string | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.group_folder)) return undefined;
  return {
    bundleId: row.bundle_id,
    groupFolder: row.group_folder,
    title: row.title,
    originKind: row.origin_kind,
    originCapability: row.origin_capability,
    sourceContextKey: row.source_context_key,
    sourceContextJson: row.source_context_json,
    presentationChannel: row.presentation_channel,
    presentationChatJid: row.presentation_chat_jid,
    presentationThreadId: row.presentation_thread_id,
    presentationMessageId: row.presentation_message_id,
    presentationMode: row.presentation_mode,
    bundleStatus: row.bundle_status,
    userConfirmed: row.user_confirmed === 1,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUpdatedAt: row.last_updated_at,
    relatedRefsJson: row.related_refs_json,
  };
}

export function listActionBundleActions(
  bundleId: string,
): ActionBundleActionRecord[] {
  const rows = db
    .prepare(
      `
        SELECT *
        FROM action_bundle_actions
        WHERE bundle_id = ?
        ORDER BY order_index ASC
      `,
    )
    .all(bundleId) as Array<{
      action_id: string;
      bundle_id: string;
      order_index: number;
      action_type: ActionBundleActionRecord['actionType'];
      target_system: ActionBundleActionRecord['targetSystem'];
      summary: string;
      requires_confirmation: number;
      status: ActionBundleActionRecord['status'];
      delegation_rule_id: string | null;
      delegation_mode: NonNullable<ActionBundleActionRecord['delegationMode']> | null;
      delegation_explanation: string | null;
      failure_reason: string | null;
      payload_json: string;
      result_ref_json: string | null;
      created_at: string;
      last_updated_at: string;
    }>;

  return rows.map((row) => ({
    actionId: row.action_id,
    bundleId: row.bundle_id,
    orderIndex: row.order_index,
    actionType: row.action_type,
    targetSystem: row.target_system,
    summary: row.summary,
    requiresConfirmation: row.requires_confirmation === 1,
    status: row.status,
    delegationRuleId: row.delegation_rule_id,
    delegationMode: row.delegation_mode,
    delegationExplanation: row.delegation_explanation,
    failureReason: row.failure_reason,
    payloadJson: row.payload_json,
    resultRefJson: row.result_ref_json,
    createdAt: row.created_at,
    lastUpdatedAt: row.last_updated_at,
  }));
}

export function getActionBundleSnapshot(
  bundleId: string,
): ActionBundleSnapshot | undefined {
  const bundle = getActionBundle(bundleId);
  if (!bundle) return undefined;
  return {
    bundle,
    actions: listActionBundleActions(bundleId),
  };
}

export function listActionBundlesForGroup(params: {
  groupFolder: string;
  statuses?: ActionBundleRecord['bundleStatus'][];
  limit?: number;
}): ActionBundleSnapshot[] {
  assertValidGroupFolder(params.groupFolder);
  const clauses = ['group_folder = ?'];
  const args: unknown[] = [params.groupFolder];
  if (params.statuses?.length) {
    clauses.push(`bundle_status IN (${params.statuses.map(() => '?').join(', ')})`);
    args.push(...params.statuses);
  }
  args.push(Math.max(1, params.limit || 25));
  const rows = db
    .prepare(
      `
        SELECT bundle_id
        FROM action_bundles
        WHERE ${clauses.join(' AND ')}
        ORDER BY last_updated_at DESC
        LIMIT ?
      `,
    )
    .all(...args) as Array<{ bundle_id: string }>;
  return rows
    .map((row) => getActionBundleSnapshot(row.bundle_id))
    .filter((snapshot): snapshot is ActionBundleSnapshot => Boolean(snapshot));
}

export function findOpenActionBundleBySource(
  groupFolder: string,
  sourceContextKey: string,
  now = new Date().toISOString(),
): ActionBundleRecord | undefined {
  if (!sourceContextKey.trim()) return undefined;
  const row = db
    .prepare(
      `
        SELECT bundle_id
        FROM action_bundles
        WHERE group_folder = ?
          AND source_context_key = ?
          AND bundle_status IN ('open', 'partially_done')
          AND expires_at > ?
        ORDER BY last_updated_at DESC
        LIMIT 1
      `,
    )
    .get(groupFolder, sourceContextKey, now) as { bundle_id: string } | undefined;
  return row ? getActionBundle(row.bundle_id) : undefined;
}

export function findLatestOpenActionBundleForChat(params: {
  groupFolder: string;
  presentationChannel: ActionBundleRecord['presentationChannel'];
  presentationChatJid: string;
  now?: string;
}): ActionBundleRecord | undefined {
  const row = db
    .prepare(
      `
        SELECT bundle_id
        FROM action_bundles
        WHERE group_folder = ?
          AND presentation_channel = ?
          AND presentation_chat_jid = ?
          AND bundle_status IN ('open', 'partially_done')
          AND expires_at > ?
        ORDER BY last_updated_at DESC
        LIMIT 1
      `,
    )
    .get(
      params.groupFolder,
      params.presentationChannel,
      params.presentationChatJid,
      params.now || new Date().toISOString(),
    ) as { bundle_id: string } | undefined;
  return row ? getActionBundle(row.bundle_id) : undefined;
}

export function updateActionBundle(
  bundleId: string,
  updates: Partial<
    Pick<
      ActionBundleRecord,
      | 'title'
      | 'presentationChannel'
      | 'presentationChatJid'
      | 'presentationThreadId'
      | 'presentationMessageId'
      | 'presentationMode'
      | 'bundleStatus'
      | 'userConfirmed'
      | 'expiresAt'
      | 'lastUpdatedAt'
      | 'relatedRefsJson'
    >
  >,
): void {
  const existing = getActionBundle(bundleId);
  if (!existing) return;
  upsertActionBundle({
    ...existing,
    title: updates.title ?? existing.title,
    presentationChannel:
      updates.presentationChannel ?? existing.presentationChannel,
    presentationChatJid:
      updates.presentationChatJid !== undefined
        ? updates.presentationChatJid
        : existing.presentationChatJid,
    presentationThreadId:
      updates.presentationThreadId !== undefined
        ? updates.presentationThreadId
        : existing.presentationThreadId,
    presentationMessageId:
      updates.presentationMessageId !== undefined
        ? updates.presentationMessageId
        : existing.presentationMessageId,
    presentationMode:
      updates.presentationMode !== undefined
        ? updates.presentationMode
        : existing.presentationMode,
    bundleStatus: updates.bundleStatus ?? existing.bundleStatus,
    userConfirmed:
      updates.userConfirmed !== undefined
        ? updates.userConfirmed
        : existing.userConfirmed,
    expiresAt: updates.expiresAt ?? existing.expiresAt,
    lastUpdatedAt: updates.lastUpdatedAt ?? new Date().toISOString(),
    relatedRefsJson:
      updates.relatedRefsJson !== undefined
        ? updates.relatedRefsJson
        : existing.relatedRefsJson,
  });
}

export function updateActionBundleAction(
  actionId: string,
  updates: Partial<
    Pick<
      ActionBundleActionRecord,
      'status' | 'failureReason' | 'resultRefJson' | 'lastUpdatedAt'
    >
  >,
): void {
  const existing = db
    .prepare(
      `
        SELECT *
        FROM action_bundle_actions
        WHERE action_id = ?
        LIMIT 1
      `,
    )
    .get(actionId) as
    | {
        action_id: string;
        bundle_id: string;
        order_index: number;
        action_type: ActionBundleActionRecord['actionType'];
        target_system: ActionBundleActionRecord['targetSystem'];
        summary: string;
        requires_confirmation: number;
        status: ActionBundleActionRecord['status'];
        failure_reason: string | null;
        payload_json: string;
        result_ref_json: string | null;
        created_at: string;
        last_updated_at: string;
      }
    | undefined;
  if (!existing) return;
  db.prepare(
    `
      UPDATE action_bundle_actions
      SET status = ?,
          failure_reason = ?,
          result_ref_json = ?,
          last_updated_at = ?
      WHERE action_id = ?
    `,
  ).run(
    updates.status ?? existing.status,
    updates.failureReason !== undefined
      ? updates.failureReason
      : existing.failure_reason,
    updates.resultRefJson !== undefined
      ? updates.resultRefJson
      : existing.result_ref_json,
    updates.lastUpdatedAt ?? new Date().toISOString(),
    actionId,
  );
}

export function purgeExpiredActionBundles(
  now = new Date().toISOString(),
): number {
  const result = db
    .prepare(
      `
        UPDATE action_bundles
        SET bundle_status = 'expired',
            last_updated_at = ?
        WHERE expires_at <= ?
          AND bundle_status IN ('open', 'partially_done')
      `,
    )
    .run(now, now);
  return result.changes;
}

function parseCommunicationStringArray(
  value: string | null | undefined,
): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function mapMissionRow(row: {
  mission_id: string;
  group_folder: string;
  title: string;
  objective: string;
  category: MissionRecord['category'];
  status: MissionRecord['status'];
  scope: MissionRecord['scope'];
  linked_life_thread_ids_json: string;
  linked_subject_ids_json: string;
  linked_reminder_ids_json: string;
  linked_current_work_json: string | null;
  linked_knowledge_source_ids_json: string;
  summary: string;
  suggested_next_action_json: string | null;
  blockers_json: string | null;
  due_horizon: MissionRecord['dueHorizon'];
  due_at: string | null;
  muted_suggested_action_kinds_json: string;
  user_confirmed: number;
  created_at: string;
  last_updated_at: string;
}): MissionRecord {
  return {
    missionId: row.mission_id,
    groupFolder: row.group_folder,
    title: row.title,
    objective: row.objective,
    category: row.category,
    status: row.status,
    scope: row.scope,
    linkedLifeThreadIds: parseCommunicationStringArray(
      row.linked_life_thread_ids_json,
    ),
    linkedSubjectIds: parseCommunicationStringArray(
      row.linked_subject_ids_json,
    ),
    linkedReminderIds: parseCommunicationStringArray(
      row.linked_reminder_ids_json,
    ),
    linkedCurrentWorkJson: row.linked_current_work_json,
    linkedKnowledgeSourceIds: parseCommunicationStringArray(
      row.linked_knowledge_source_ids_json,
    ),
    summary: row.summary,
    suggestedNextActionJson: row.suggested_next_action_json,
    blockersJson: row.blockers_json,
    dueHorizon: row.due_horizon || null,
    dueAt: row.due_at,
    mutedSuggestedActionKinds: parseCommunicationStringArray(
      row.muted_suggested_action_kinds_json,
    ) as MissionRecord['mutedSuggestedActionKinds'],
    createdAt: row.created_at,
    lastUpdatedAt: row.last_updated_at,
    userConfirmed: row.user_confirmed === 1,
  };
}

function mapMissionStepRow(row: {
  step_id: string;
  mission_id: string;
  position: number;
  title: string;
  detail: string | null;
  step_status: MissionStepRecord['stepStatus'];
  requires_user_judgment: number;
  suggested_action_kind: MissionStepRecord['suggestedActionKind'];
  linked_ref_json: string | null;
  last_updated_at: string;
}): MissionStepRecord {
  return {
    stepId: row.step_id,
    missionId: row.mission_id,
    position: row.position,
    title: row.title,
    detail: row.detail,
    stepStatus: row.step_status,
    requiresUserJudgment: row.requires_user_judgment === 1,
    suggestedActionKind: row.suggested_action_kind || null,
    linkedRefJson: row.linked_ref_json,
    lastUpdatedAt: row.last_updated_at,
  };
}

export function upsertMission(record: MissionRecord): void {
  assertValidGroupFolder(record.groupFolder);
  db.prepare(
    `
      INSERT INTO missions (
        mission_id,
        group_folder,
        title,
        objective,
        category,
        status,
        scope,
        linked_life_thread_ids_json,
        linked_subject_ids_json,
        linked_reminder_ids_json,
        linked_current_work_json,
        linked_knowledge_source_ids_json,
        summary,
        suggested_next_action_json,
        blockers_json,
        due_horizon,
        due_at,
        muted_suggested_action_kinds_json,
        user_confirmed,
        created_at,
        last_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mission_id) DO UPDATE SET
        group_folder = excluded.group_folder,
        title = excluded.title,
        objective = excluded.objective,
        category = excluded.category,
        status = excluded.status,
        scope = excluded.scope,
        linked_life_thread_ids_json = excluded.linked_life_thread_ids_json,
        linked_subject_ids_json = excluded.linked_subject_ids_json,
        linked_reminder_ids_json = excluded.linked_reminder_ids_json,
        linked_current_work_json = excluded.linked_current_work_json,
        linked_knowledge_source_ids_json = excluded.linked_knowledge_source_ids_json,
        summary = excluded.summary,
        suggested_next_action_json = excluded.suggested_next_action_json,
        blockers_json = excluded.blockers_json,
        due_horizon = excluded.due_horizon,
        due_at = excluded.due_at,
        muted_suggested_action_kinds_json = excluded.muted_suggested_action_kinds_json,
        user_confirmed = excluded.user_confirmed,
        created_at = excluded.created_at,
        last_updated_at = excluded.last_updated_at
    `,
  ).run(
    record.missionId,
    record.groupFolder,
    record.title,
    record.objective,
    record.category,
    record.status,
    record.scope,
    JSON.stringify(record.linkedLifeThreadIds || []),
    JSON.stringify(record.linkedSubjectIds || []),
    JSON.stringify(record.linkedReminderIds || []),
    record.linkedCurrentWorkJson || null,
    JSON.stringify(record.linkedKnowledgeSourceIds || []),
    record.summary,
    record.suggestedNextActionJson || null,
    record.blockersJson || null,
    record.dueHorizon || null,
    record.dueAt || null,
    JSON.stringify(record.mutedSuggestedActionKinds || []),
    record.userConfirmed ? 1 : 0,
    record.createdAt,
    record.lastUpdatedAt,
  );
}

export function getMission(missionId: string): MissionRecord | undefined {
  const row = db
    .prepare(
      `
        SELECT *
        FROM missions
        WHERE mission_id = ?
        LIMIT 1
      `,
    )
    .get(missionId) as
    | {
        mission_id: string;
        group_folder: string;
        title: string;
        objective: string;
        category: MissionRecord['category'];
        status: MissionRecord['status'];
        scope: MissionRecord['scope'];
        linked_life_thread_ids_json: string;
        linked_subject_ids_json: string;
        linked_reminder_ids_json: string;
        linked_current_work_json: string | null;
        linked_knowledge_source_ids_json: string;
        summary: string;
        suggested_next_action_json: string | null;
        blockers_json: string | null;
        due_horizon: MissionRecord['dueHorizon'];
        due_at: string | null;
        muted_suggested_action_kinds_json: string;
        user_confirmed: number;
        created_at: string;
        last_updated_at: string;
      }
    | undefined;
  if (!row || !isValidGroupFolder(row.group_folder)) return undefined;
  return mapMissionRow(row);
}

export function listMissionsForGroup(params: {
  groupFolder: string;
  statuses?: MissionRecord['status'][];
  includeUnconfirmed?: boolean;
  limit?: number;
}): MissionRecord[] {
  assertValidGroupFolder(params.groupFolder);
  const clauses = ['group_folder = ?'];
  const args: unknown[] = [params.groupFolder];
  if (params.statuses?.length) {
    clauses.push(`status IN (${params.statuses.map(() => '?').join(', ')})`);
    args.push(...params.statuses);
  }
  if (!params.includeUnconfirmed) {
    clauses.push("(user_confirmed = 1 OR status = 'active')");
  }
  const limit = Math.max(1, params.limit || 25);
  args.push(limit);
  const rows = db
    .prepare(
      `
        SELECT *
        FROM missions
        WHERE ${clauses.join(' AND ')}
        ORDER BY
          CASE status
            WHEN 'active' THEN 0
            WHEN 'blocked' THEN 1
            WHEN 'proposed' THEN 2
            WHEN 'paused' THEN 3
            WHEN 'completed' THEN 4
            ELSE 5
          END,
          last_updated_at DESC
        LIMIT ?
      `,
    )
    .all(...args) as Array<{
    mission_id: string;
    group_folder: string;
    title: string;
    objective: string;
    category: MissionRecord['category'];
    status: MissionRecord['status'];
    scope: MissionRecord['scope'];
    linked_life_thread_ids_json: string;
    linked_subject_ids_json: string;
    linked_reminder_ids_json: string;
    linked_current_work_json: string | null;
    linked_knowledge_source_ids_json: string;
    summary: string;
    suggested_next_action_json: string | null;
    blockers_json: string | null;
    due_horizon: MissionRecord['dueHorizon'];
    due_at: string | null;
    muted_suggested_action_kinds_json: string;
    user_confirmed: number;
    created_at: string;
    last_updated_at: string;
  }>;
  return rows
    .filter((row) => isValidGroupFolder(row.group_folder))
    .map((row) => mapMissionRow(row));
}

export function updateMission(
  missionId: string,
  updates: Partial<
    Omit<MissionRecord, 'missionId' | 'groupFolder' | 'createdAt'>
  >,
): boolean {
  const existing = getMission(missionId);
  if (!existing) return false;
  upsertMission({
    ...existing,
    ...updates,
    lastUpdatedAt: updates.lastUpdatedAt || new Date().toISOString(),
  });
  return true;
}

export function upsertMissionStep(record: MissionStepRecord): void {
  db.prepare(
    `
      INSERT INTO mission_steps (
        step_id,
        mission_id,
        position,
        title,
        detail,
        step_status,
        requires_user_judgment,
        suggested_action_kind,
        linked_ref_json,
        last_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(step_id) DO UPDATE SET
        mission_id = excluded.mission_id,
        position = excluded.position,
        title = excluded.title,
        detail = excluded.detail,
        step_status = excluded.step_status,
        requires_user_judgment = excluded.requires_user_judgment,
        suggested_action_kind = excluded.suggested_action_kind,
        linked_ref_json = excluded.linked_ref_json,
        last_updated_at = excluded.last_updated_at
    `,
  ).run(
    record.stepId,
    record.missionId,
    record.position,
    record.title,
    record.detail || null,
    record.stepStatus,
    record.requiresUserJudgment ? 1 : 0,
    record.suggestedActionKind || null,
    record.linkedRefJson || null,
    record.lastUpdatedAt,
  );
}

export function listMissionSteps(missionId: string): MissionStepRecord[] {
  const rows = db
    .prepare(
      `
        SELECT *
        FROM mission_steps
        WHERE mission_id = ?
        ORDER BY position ASC
      `,
    )
    .all(missionId) as Array<{
    step_id: string;
    mission_id: string;
    position: number;
    title: string;
    detail: string | null;
    step_status: MissionStepRecord['stepStatus'];
    requires_user_judgment: number;
    suggested_action_kind: MissionStepRecord['suggestedActionKind'];
    linked_ref_json: string | null;
    last_updated_at: string;
  }>;
  return rows.map((row) => mapMissionStepRow(row));
}

export function replaceMissionSteps(
  missionId: string,
  steps: MissionStepRecord[],
): void {
  const deleteStmt = db.prepare(
    'DELETE FROM mission_steps WHERE mission_id = ?',
  );
  const insert = db.transaction((nextSteps: MissionStepRecord[]) => {
    deleteStmt.run(missionId);
    for (const step of nextSteps) {
      upsertMissionStep(step);
    }
  });
  insert(steps);
}

function mapCommunicationThreadRow(row: {
  id: string;
  group_folder: string;
  title: string;
  linked_subject_ids_json: string;
  linked_life_thread_ids_json: string;
  channel: CommunicationThreadRecord['channel'];
  channel_chat_jid: string | null;
  last_inbound_summary: string | null;
  last_outbound_summary: string | null;
  followup_state: CommunicationThreadRecord['followupState'];
  urgency: CommunicationThreadRecord['urgency'];
  followup_due_at: string | null;
  suggested_next_action: CommunicationThreadRecord['suggestedNextAction'];
  tone_style_hints_json: string;
  last_contact_at: string | null;
  last_message_id: string | null;
  linked_task_id: string | null;
  inference_state: CommunicationThreadRecord['inferenceState'];
  tracking_mode: CommunicationThreadRecord['trackingMode'];
  created_at: string;
  updated_at: string;
  disabled_at: string | null;
}): CommunicationThreadRecord {
  return {
    id: row.id,
    groupFolder: row.group_folder,
    title: row.title,
    linkedSubjectIds: parseCommunicationStringArray(
      row.linked_subject_ids_json,
    ),
    linkedLifeThreadIds: parseCommunicationStringArray(
      row.linked_life_thread_ids_json,
    ),
    channel: row.channel,
    channelChatJid: row.channel_chat_jid,
    lastInboundSummary: row.last_inbound_summary,
    lastOutboundSummary: row.last_outbound_summary,
    followupState: row.followup_state,
    urgency: row.urgency,
    followupDueAt: row.followup_due_at,
    suggestedNextAction: row.suggested_next_action,
    toneStyleHints: parseCommunicationStringArray(row.tone_style_hints_json),
    lastContactAt: row.last_contact_at,
    lastMessageId: row.last_message_id,
    linkedTaskId: row.linked_task_id,
    inferenceState: row.inference_state,
    trackingMode: row.tracking_mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    disabledAt: row.disabled_at,
  };
}

export function upsertCommunicationThread(
  record: CommunicationThreadRecord,
): void {
  assertValidGroupFolder(record.groupFolder);
  db.prepare(
    `
      INSERT INTO communication_threads (
        id,
        group_folder,
        title,
        linked_subject_ids_json,
        linked_life_thread_ids_json,
        channel,
        channel_chat_jid,
        last_inbound_summary,
        last_outbound_summary,
        followup_state,
        urgency,
        followup_due_at,
        suggested_next_action,
        tone_style_hints_json,
        last_contact_at,
        last_message_id,
        linked_task_id,
        inference_state,
        tracking_mode,
        created_at,
        updated_at,
        disabled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        group_folder = excluded.group_folder,
        title = excluded.title,
        linked_subject_ids_json = excluded.linked_subject_ids_json,
        linked_life_thread_ids_json = excluded.linked_life_thread_ids_json,
        channel = excluded.channel,
        channel_chat_jid = excluded.channel_chat_jid,
        last_inbound_summary = excluded.last_inbound_summary,
        last_outbound_summary = excluded.last_outbound_summary,
        followup_state = excluded.followup_state,
        urgency = excluded.urgency,
        followup_due_at = excluded.followup_due_at,
        suggested_next_action = excluded.suggested_next_action,
        tone_style_hints_json = excluded.tone_style_hints_json,
        last_contact_at = excluded.last_contact_at,
        last_message_id = excluded.last_message_id,
        linked_task_id = excluded.linked_task_id,
        inference_state = excluded.inference_state,
        tracking_mode = excluded.tracking_mode,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        disabled_at = excluded.disabled_at
    `,
  ).run(
    record.id,
    record.groupFolder,
    record.title,
    JSON.stringify(record.linkedSubjectIds || []),
    JSON.stringify(record.linkedLifeThreadIds || []),
    record.channel,
    record.channelChatJid || null,
    record.lastInboundSummary || null,
    record.lastOutboundSummary || null,
    record.followupState,
    record.urgency,
    record.followupDueAt || null,
    record.suggestedNextAction || null,
    JSON.stringify(record.toneStyleHints || []),
    record.lastContactAt || null,
    record.lastMessageId || null,
    record.linkedTaskId || null,
    record.inferenceState,
    record.trackingMode,
    record.createdAt,
    record.updatedAt,
    record.disabledAt || null,
  );
}

export function getCommunicationThread(
  id: string,
): CommunicationThreadRecord | undefined {
  const row = db
    .prepare(
      `
        SELECT *
        FROM communication_threads
        WHERE id = ?
        LIMIT 1
      `,
    )
    .get(id) as
    | {
        id: string;
        group_folder: string;
        title: string;
        linked_subject_ids_json: string;
        linked_life_thread_ids_json: string;
        channel: CommunicationThreadRecord['channel'];
        channel_chat_jid: string | null;
        last_inbound_summary: string | null;
        last_outbound_summary: string | null;
        followup_state: CommunicationThreadRecord['followupState'];
        urgency: CommunicationThreadRecord['urgency'];
        followup_due_at: string | null;
        suggested_next_action: CommunicationThreadRecord['suggestedNextAction'];
        tone_style_hints_json: string;
        last_contact_at: string | null;
        last_message_id: string | null;
        linked_task_id: string | null;
        inference_state: CommunicationThreadRecord['inferenceState'];
        tracking_mode: CommunicationThreadRecord['trackingMode'];
        created_at: string;
        updated_at: string;
        disabled_at: string | null;
      }
    | undefined;
  if (!row || !isValidGroupFolder(row.group_folder)) return undefined;
  return mapCommunicationThreadRow(row);
}

export function listCommunicationThreadsForGroup(params: {
  groupFolder: string;
  includeDisabled?: boolean;
  followupStates?: CommunicationThreadRecord['followupState'][];
  subjectId?: string;
  limit?: number;
}): CommunicationThreadRecord[] {
  assertValidGroupFolder(params.groupFolder);
  const clauses = ['group_folder = ?'];
  const args: unknown[] = [params.groupFolder];
  if (!params.includeDisabled) {
    clauses.push('disabled_at IS NULL');
    clauses.push("tracking_mode != 'disabled'");
  }
  if (params.followupStates?.length) {
    clauses.push(
      `followup_state IN (${params.followupStates.map(() => '?').join(', ')})`,
    );
    args.push(...params.followupStates);
  }
  if (params.subjectId) {
    clauses.push('linked_subject_ids_json LIKE ?');
    args.push(`%${params.subjectId}%`);
  }
  const limit = Math.max(1, params.limit || 50);
  args.push(limit);

  const rows = db
    .prepare(
      `
        SELECT *
        FROM communication_threads
        WHERE ${clauses.join(' AND ')}
        ORDER BY
          CASE urgency
            WHEN 'overdue' THEN 0
            WHEN 'tonight' THEN 1
            WHEN 'tomorrow' THEN 2
            WHEN 'soon' THEN 3
            ELSE 4
          END,
          CASE followup_state
            WHEN 'reply_needed' THEN 0
            WHEN 'scheduled' THEN 1
            WHEN 'waiting_on_them' THEN 2
            ELSE 3
          END,
          COALESCE(last_contact_at, updated_at) DESC
        LIMIT ?
      `,
    )
    .all(...args) as Array<{
    id: string;
    group_folder: string;
    title: string;
    linked_subject_ids_json: string;
    linked_life_thread_ids_json: string;
    channel: CommunicationThreadRecord['channel'];
    channel_chat_jid: string | null;
    last_inbound_summary: string | null;
    last_outbound_summary: string | null;
    followup_state: CommunicationThreadRecord['followupState'];
    urgency: CommunicationThreadRecord['urgency'];
    followup_due_at: string | null;
    suggested_next_action: CommunicationThreadRecord['suggestedNextAction'];
    tone_style_hints_json: string;
    last_contact_at: string | null;
    last_message_id: string | null;
    linked_task_id: string | null;
    inference_state: CommunicationThreadRecord['inferenceState'];
    tracking_mode: CommunicationThreadRecord['trackingMode'];
    created_at: string;
    updated_at: string;
    disabled_at: string | null;
  }>;

  return rows
    .filter((row) => isValidGroupFolder(row.group_folder))
    .map((row) => mapCommunicationThreadRow(row));
}

export function updateCommunicationThread(
  id: string,
  updates: Partial<
    Omit<CommunicationThreadRecord, 'id' | 'groupFolder' | 'createdAt'>
  >,
): boolean {
  const existing = getCommunicationThread(id);
  if (!existing) return false;
  upsertCommunicationThread({
    ...existing,
    ...updates,
    updatedAt: updates.updatedAt || new Date().toISOString(),
  });
  return true;
}

export function deleteCommunicationThread(id: string): boolean {
  db.prepare(
    'DELETE FROM communication_signals WHERE communication_thread_id = ?',
  ).run(id);
  const result = db
    .prepare('DELETE FROM communication_threads WHERE id = ?')
    .run(id);
  return result.changes === 1;
}

export function upsertCommunicationSignal(
  record: CommunicationSignalRecord,
): void {
  assertValidGroupFolder(record.groupFolder);
  db.prepare(
    `
      INSERT INTO communication_signals (
        id,
        communication_thread_id,
        group_folder,
        source_channel,
        chat_jid,
        message_id,
        direction,
        summary_text,
        followup_state,
        suggested_action,
        urgency,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        communication_thread_id = excluded.communication_thread_id,
        group_folder = excluded.group_folder,
        source_channel = excluded.source_channel,
        chat_jid = excluded.chat_jid,
        message_id = excluded.message_id,
        direction = excluded.direction,
        summary_text = excluded.summary_text,
        followup_state = excluded.followup_state,
        suggested_action = excluded.suggested_action,
        urgency = excluded.urgency,
        created_at = excluded.created_at
    `,
  ).run(
    record.id,
    record.communicationThreadId,
    record.groupFolder,
    record.sourceChannel,
    record.chatJid || null,
    record.messageId || null,
    record.direction,
    record.summaryText,
    record.followupState,
    record.suggestedAction || null,
    record.urgency,
    record.createdAt,
  );
}

export function listCommunicationSignalsForThread(
  communicationThreadId: string,
  limit = 10,
): CommunicationSignalRecord[] {
  const rows = db
    .prepare(
      `
        SELECT *
        FROM communication_signals
        WHERE communication_thread_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `,
    )
    .all(communicationThreadId, Math.max(1, limit)) as Array<{
    id: string;
    communication_thread_id: string;
    group_folder: string;
    source_channel: CommunicationSignalRecord['sourceChannel'];
    chat_jid: string | null;
    message_id: string | null;
    direction: CommunicationSignalRecord['direction'];
    summary_text: string;
    followup_state: CommunicationSignalRecord['followupState'];
    suggested_action: CommunicationSignalRecord['suggestedAction'];
    urgency: CommunicationSignalRecord['urgency'];
    created_at: string;
  }>;

  return rows
    .filter((row) => isValidGroupFolder(row.group_folder))
    .map((row) => ({
      id: row.id,
      communicationThreadId: row.communication_thread_id,
      groupFolder: row.group_folder,
      sourceChannel: row.source_channel,
      chatJid: row.chat_jid,
      messageId: row.message_id,
      direction: row.direction,
      summaryText: row.summary_text,
      followupState: row.followup_state,
      suggestedAction: row.suggested_action,
      urgency: row.urgency,
      createdAt: row.created_at,
    }));
}

function mapPilotJourneyEventRow(row: {
  event_id: string;
  journey_id: PilotJourneyEventRecord['journeyId'];
  channel: PilotJourneyEventRecord['channel'];
  group_folder: string;
  chat_jid: string | null;
  thread_id: string | null;
  route_key: string | null;
  systems_involved_json: string;
  outcome: PilotJourneyEventRecord['outcome'];
  blocker_class: string | null;
  blocker_owner: PilotJourneyEventRecord['blockerOwner'];
  degraded_path: string | null;
  handoff_created: number;
  mission_created: number;
  thread_saved: number;
  reminder_created: number;
  library_saved: number;
  current_work_ref: string | null;
  summary_text: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
}): PilotJourneyEventRecord {
  return {
    eventId: row.event_id,
    journeyId: row.journey_id,
    channel: row.channel,
    groupFolder: row.group_folder,
    chatJid: row.chat_jid,
    threadId: row.thread_id,
    routeKey: row.route_key,
    systemsInvolved: parseStringArrayJson(row.systems_involved_json),
    outcome: row.outcome,
    blockerClass: row.blocker_class,
    blockerOwner: row.blocker_owner,
    degradedPath: row.degraded_path,
    handoffCreated: Boolean(row.handoff_created),
    missionCreated: Boolean(row.mission_created),
    threadSaved: Boolean(row.thread_saved),
    reminderCreated: Boolean(row.reminder_created),
    librarySaved: Boolean(row.library_saved),
    currentWorkRef: row.current_work_ref,
    summaryText: row.summary_text,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
  };
}

export function insertPilotJourneyEvent(record: PilotJourneyEventRecord): void {
  assertValidGroupFolder(record.groupFolder);
  db.prepare(
    `
      INSERT INTO pilot_journey_events (
        event_id,
        journey_id,
        channel,
        group_folder,
        chat_jid,
        thread_id,
        route_key,
        systems_involved_json,
        outcome,
        blocker_class,
        blocker_owner,
        degraded_path,
        handoff_created,
        mission_created,
        thread_saved,
        reminder_created,
        library_saved,
        current_work_ref,
        summary_text,
        started_at,
        completed_at,
        duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET
        journey_id = excluded.journey_id,
        channel = excluded.channel,
        group_folder = excluded.group_folder,
        chat_jid = excluded.chat_jid,
        thread_id = excluded.thread_id,
        route_key = excluded.route_key,
        systems_involved_json = excluded.systems_involved_json,
        outcome = excluded.outcome,
        blocker_class = excluded.blocker_class,
        blocker_owner = excluded.blocker_owner,
        degraded_path = excluded.degraded_path,
        handoff_created = excluded.handoff_created,
        mission_created = excluded.mission_created,
        thread_saved = excluded.thread_saved,
        reminder_created = excluded.reminder_created,
        library_saved = excluded.library_saved,
        current_work_ref = excluded.current_work_ref,
        summary_text = excluded.summary_text,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        duration_ms = excluded.duration_ms
    `,
  ).run(
    record.eventId,
    record.journeyId,
    record.channel,
    record.groupFolder,
    record.chatJid || null,
    record.threadId || null,
    record.routeKey || null,
    JSON.stringify(record.systemsInvolved || []),
    record.outcome,
    record.blockerClass || null,
    record.blockerOwner,
    record.degradedPath || null,
    record.handoffCreated ? 1 : 0,
    record.missionCreated ? 1 : 0,
    record.threadSaved ? 1 : 0,
    record.reminderCreated ? 1 : 0,
    record.librarySaved ? 1 : 0,
    record.currentWorkRef || null,
    record.summaryText,
    record.startedAt,
    record.completedAt || null,
    record.durationMs ?? null,
  );
}

export function finalizePilotJourneyEvent(
  eventId: string,
  updates: Partial<
    Omit<
      PilotJourneyEventRecord,
      'eventId' | 'journeyId' | 'channel' | 'groupFolder' | 'startedAt'
    >
  >,
): boolean {
  const existing = getPilotJourneyEvent(eventId);
  if (!existing) return false;
  insertPilotJourneyEvent({
    ...existing,
    ...updates,
  });
  return true;
}

export function getPilotJourneyEvent(
  eventId: string,
): PilotJourneyEventRecord | null {
  const row = db
    .prepare(
      `
        SELECT *
        FROM pilot_journey_events
        WHERE event_id = ?
      `,
    )
    .get(eventId) as
    | {
        event_id: string;
        journey_id: PilotJourneyEventRecord['journeyId'];
        channel: PilotJourneyEventRecord['channel'];
        group_folder: string;
        chat_jid: string | null;
        thread_id: string | null;
        route_key: string | null;
        systems_involved_json: string;
        outcome: PilotJourneyEventRecord['outcome'];
        blocker_class: string | null;
        blocker_owner: PilotJourneyEventRecord['blockerOwner'];
        degraded_path: string | null;
        handoff_created: number;
        mission_created: number;
        thread_saved: number;
        reminder_created: number;
        library_saved: number;
        current_work_ref: string | null;
        summary_text: string;
        started_at: string;
        completed_at: string | null;
        duration_ms: number | null;
      }
    | undefined;

  if (!row || !isValidGroupFolder(row.group_folder)) {
    return null;
  }

  return mapPilotJourneyEventRow(row);
}

export function listRecentPilotJourneyEvents(params: {
  limit?: number;
  journeyId?: PilotJourneyEventRecord['journeyId'];
  channel?: PilotJourneyEventRecord['channel'];
  outcome?: PilotJourneyEventRecord['outcome'];
} = {}): PilotJourneyEventRecord[] {
  const clauses: string[] = [];
  const values: Array<string | number> = [];

  if (params.journeyId) {
    clauses.push('journey_id = ?');
    values.push(params.journeyId);
  }
  if (params.channel) {
    clauses.push('channel = ?');
    values.push(params.channel);
  }
  if (params.outcome) {
    clauses.push('outcome = ?');
    values.push(params.outcome);
  }

  const sql = [
    'SELECT *',
    'FROM pilot_journey_events',
    clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    'ORDER BY started_at DESC',
    'LIMIT ?',
  ]
    .filter(Boolean)
    .join('\n');
  values.push(Math.max(1, params.limit || 20));

  const rows = db.prepare(sql).all(...values) as Array<{
    event_id: string;
    journey_id: PilotJourneyEventRecord['journeyId'];
    channel: PilotJourneyEventRecord['channel'];
    group_folder: string;
    chat_jid: string | null;
    thread_id: string | null;
    route_key: string | null;
    systems_involved_json: string;
    outcome: PilotJourneyEventRecord['outcome'];
    blocker_class: string | null;
    blocker_owner: PilotJourneyEventRecord['blockerOwner'];
    degraded_path: string | null;
    handoff_created: number;
    mission_created: number;
    thread_saved: number;
    reminder_created: number;
    library_saved: number;
    current_work_ref: string | null;
    summary_text: string;
    started_at: string;
    completed_at: string | null;
    duration_ms: number | null;
  }>;

  return rows
    .filter((row) => isValidGroupFolder(row.group_folder))
    .map((row) => mapPilotJourneyEventRow(row));
}

export function findRecentPilotJourneyEvent(params: {
  chatJid?: string | null;
  threadId?: string | null;
  maxAgeMinutes?: number;
}): PilotJourneyEventRecord | null {
  const maxAgeMinutes = Math.max(1, params.maxAgeMinutes || 30);
  const cutoffIso = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();
  const clauses = ['started_at >= ?'];
  const values: Array<string> = [cutoffIso];

  if (params.chatJid) {
    clauses.push('chat_jid = ?');
    values.push(params.chatJid);
  }
  if (params.threadId) {
    clauses.push('thread_id = ?');
    values.push(params.threadId);
  }

  const row = db
    .prepare(
      `
        SELECT *
        FROM pilot_journey_events
        WHERE ${clauses.join(' AND ')}
        ORDER BY started_at DESC
        LIMIT 1
      `,
    )
    .get(...values) as
    | {
        event_id: string;
        journey_id: PilotJourneyEventRecord['journeyId'];
        channel: PilotJourneyEventRecord['channel'];
        group_folder: string;
        chat_jid: string | null;
        thread_id: string | null;
        route_key: string | null;
        systems_involved_json: string;
        outcome: PilotJourneyEventRecord['outcome'];
        blocker_class: string | null;
        blocker_owner: PilotJourneyEventRecord['blockerOwner'];
        degraded_path: string | null;
        handoff_created: number;
        mission_created: number;
        thread_saved: number;
        reminder_created: number;
        library_saved: number;
        current_work_ref: string | null;
        summary_text: string;
        started_at: string;
        completed_at: string | null;
        duration_ms: number | null;
      }
    | undefined;

  if (!row || !isValidGroupFolder(row.group_folder)) {
    return null;
  }
  return mapPilotJourneyEventRow(row);
}

function mapPilotIssueRow(row: {
  issue_id: string;
  created_at: string;
  status: PilotIssueRecord['status'];
  issue_kind: PilotIssueRecord['issueKind'];
  channel: PilotIssueRecord['channel'];
  group_folder: string;
  chat_jid: string | null;
  thread_id: string | null;
  journey_event_id: string | null;
  route_key: string | null;
  blocker_class: string | null;
  blocker_owner: PilotIssueRecord['blockerOwner'];
  summary_text: string;
  assistant_context_summary: string;
  linked_refs_json: string;
}): PilotIssueRecord {
  return {
    issueId: row.issue_id,
    createdAt: row.created_at,
    status: row.status,
    issueKind: row.issue_kind,
    channel: row.channel,
    groupFolder: row.group_folder,
    chatJid: row.chat_jid,
    threadId: row.thread_id,
    journeyEventId: row.journey_event_id,
    routeKey: row.route_key,
    blockerClass: row.blocker_class,
    blockerOwner: row.blocker_owner,
    summaryText: row.summary_text,
    assistantContextSummary: row.assistant_context_summary,
    linkedRefs: parseJsonObject(row.linked_refs_json) as PilotIssueRecord['linkedRefs'],
  };
}

export function insertPilotIssue(record: PilotIssueRecord): void {
  assertValidGroupFolder(record.groupFolder);
  db.prepare(
    `
      INSERT INTO pilot_issues (
        issue_id,
        created_at,
        status,
        issue_kind,
        channel,
        group_folder,
        chat_jid,
        thread_id,
        journey_event_id,
        route_key,
        blocker_class,
        blocker_owner,
        summary_text,
        assistant_context_summary,
        linked_refs_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(issue_id) DO UPDATE SET
        created_at = excluded.created_at,
        status = excluded.status,
        issue_kind = excluded.issue_kind,
        channel = excluded.channel,
        group_folder = excluded.group_folder,
        chat_jid = excluded.chat_jid,
        thread_id = excluded.thread_id,
        journey_event_id = excluded.journey_event_id,
        route_key = excluded.route_key,
        blocker_class = excluded.blocker_class,
        blocker_owner = excluded.blocker_owner,
        summary_text = excluded.summary_text,
        assistant_context_summary = excluded.assistant_context_summary,
        linked_refs_json = excluded.linked_refs_json
    `,
  ).run(
    record.issueId,
    record.createdAt,
    record.status,
    record.issueKind,
    record.channel,
    record.groupFolder,
    record.chatJid || null,
    record.threadId || null,
    record.journeyEventId || null,
    record.routeKey || null,
    record.blockerClass || null,
    record.blockerOwner,
    record.summaryText,
    record.assistantContextSummary,
    JSON.stringify(record.linkedRefs || {}),
  );
}

export function listPilotIssues(params: {
  status?: PilotIssueRecord['status'];
  limit?: number;
} = {}): PilotIssueRecord[] {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (params.status) {
    clauses.push('status = ?');
    values.push(params.status);
  }
  const sql = [
    'SELECT *',
    'FROM pilot_issues',
    clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    'ORDER BY created_at DESC',
    'LIMIT ?',
  ]
    .filter(Boolean)
    .join('\n');
  values.push(Math.max(1, params.limit || 20));

  const rows = db.prepare(sql).all(...values) as Array<{
    issue_id: string;
    created_at: string;
    status: PilotIssueRecord['status'];
    issue_kind: PilotIssueRecord['issueKind'];
    channel: PilotIssueRecord['channel'];
    group_folder: string;
    chat_jid: string | null;
    thread_id: string | null;
    journey_event_id: string | null;
    route_key: string | null;
    blocker_class: string | null;
    blocker_owner: PilotIssueRecord['blockerOwner'];
    summary_text: string;
    assistant_context_summary: string;
    linked_refs_json: string;
  }>;

  return rows
    .filter((row) => isValidGroupFolder(row.group_folder))
    .map((row) => mapPilotIssueRow(row));
}

export function countPilotIssues(status?: PilotIssueRecord['status']): number {
  if (status) {
    const row = db
      .prepare('SELECT COUNT(*) as total FROM pilot_issues WHERE status = ?')
      .get(status) as { total: number };
    return row.total;
  }
  const row = db
    .prepare('SELECT COUNT(*) as total FROM pilot_issues')
    .get() as { total: number };
  return row.total;
}

function mapResponseFeedbackRow(row: {
  feedback_id: string;
  created_at: string;
  updated_at: string;
  status: ResponseFeedbackRecord['status'];
  classification: ResponseFeedbackRecord['classification'];
  channel: ResponseFeedbackRecord['channel'];
  group_folder: string;
  chat_jid: string;
  thread_id: string | null;
  platform_message_id: string | null;
  user_message_id: string | null;
  issue_id: string | null;
  route_key: string | null;
  capability_id: string | null;
  handler_kind: string | null;
  response_source: string | null;
  trace_reason: string | null;
  trace_notes_json: string;
  blocker_class: string | null;
  blocker_owner: ResponseFeedbackRecord['blockerOwner'];
  original_user_text: string;
  assistant_reply_text: string;
  linked_refs_json: string;
  remediation_lane_id: ResponseFeedbackRecord['remediationLaneId'];
  remediation_job_id: string | null;
  remediation_runtime_preference: ResponseFeedbackRecord['remediationRuntimePreference'];
  remediation_prompt: string | null;
  operator_note: string | null;
}): ResponseFeedbackRecord {
  return {
    feedbackId: row.feedback_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status,
    classification: row.classification,
    channel: row.channel,
    groupFolder: row.group_folder,
    chatJid: row.chat_jid,
    threadId: row.thread_id,
    platformMessageId: row.platform_message_id,
    userMessageId: row.user_message_id,
    issueId: row.issue_id,
    routeKey: row.route_key,
    capabilityId: row.capability_id,
    handlerKind: row.handler_kind,
    responseSource: row.response_source,
    traceReason: row.trace_reason,
    traceNotes: parseStringArrayJson(row.trace_notes_json),
    blockerClass: row.blocker_class,
    blockerOwner: row.blocker_owner,
    originalUserText: row.original_user_text,
    assistantReplyText: row.assistant_reply_text,
    linkedRefs: parseJsonObject(
      row.linked_refs_json,
    ) as ResponseFeedbackRecord['linkedRefs'],
    remediationLaneId: row.remediation_lane_id,
    remediationJobId: row.remediation_job_id,
    remediationRuntimePreference: row.remediation_runtime_preference,
    remediationPrompt: row.remediation_prompt,
    operatorNote: row.operator_note,
  };
}

export function upsertResponseFeedback(record: ResponseFeedbackRecord): void {
  assertValidGroupFolder(record.groupFolder);
  db.prepare(
    `
      INSERT INTO response_feedback (
        feedback_id,
        created_at,
        updated_at,
        status,
        classification,
        channel,
        group_folder,
        chat_jid,
        thread_id,
        platform_message_id,
        user_message_id,
        issue_id,
        route_key,
        capability_id,
        handler_kind,
        response_source,
        trace_reason,
        trace_notes_json,
        blocker_class,
        blocker_owner,
        original_user_text,
        assistant_reply_text,
        linked_refs_json,
        remediation_lane_id,
        remediation_job_id,
        remediation_runtime_preference,
        remediation_prompt,
        operator_note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(feedback_id) DO UPDATE SET
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        status = excluded.status,
        classification = excluded.classification,
        channel = excluded.channel,
        group_folder = excluded.group_folder,
        chat_jid = excluded.chat_jid,
        thread_id = excluded.thread_id,
        platform_message_id = excluded.platform_message_id,
        user_message_id = excluded.user_message_id,
        issue_id = excluded.issue_id,
        route_key = excluded.route_key,
        capability_id = excluded.capability_id,
        handler_kind = excluded.handler_kind,
        response_source = excluded.response_source,
        trace_reason = excluded.trace_reason,
        trace_notes_json = excluded.trace_notes_json,
        blocker_class = excluded.blocker_class,
        blocker_owner = excluded.blocker_owner,
        original_user_text = excluded.original_user_text,
        assistant_reply_text = excluded.assistant_reply_text,
        linked_refs_json = excluded.linked_refs_json,
        remediation_lane_id = excluded.remediation_lane_id,
        remediation_job_id = excluded.remediation_job_id,
        remediation_runtime_preference = excluded.remediation_runtime_preference,
        remediation_prompt = excluded.remediation_prompt,
        operator_note = excluded.operator_note
    `,
  ).run(
    record.feedbackId,
    record.createdAt,
    record.updatedAt,
    record.status,
    record.classification,
    record.channel,
    record.groupFolder,
    record.chatJid,
    record.threadId || null,
    record.platformMessageId || null,
    record.userMessageId || null,
    record.issueId || null,
    record.routeKey || null,
    record.capabilityId || null,
    record.handlerKind || null,
    record.responseSource || null,
    record.traceReason || null,
    JSON.stringify(record.traceNotes || []),
    record.blockerClass || null,
    record.blockerOwner,
    record.originalUserText,
    record.assistantReplyText,
    JSON.stringify(record.linkedRefs || {}),
    record.remediationLaneId || null,
    record.remediationJobId || null,
    record.remediationRuntimePreference || null,
    record.remediationPrompt || null,
    record.operatorNote || null,
  );
}

export function getResponseFeedback(
  feedbackId: string,
): ResponseFeedbackRecord | undefined {
  const row = db
    .prepare(
      `
        SELECT *
        FROM response_feedback
        WHERE feedback_id = ?
      `,
    )
    .get(feedbackId) as
    | Parameters<typeof mapResponseFeedbackRow>[0]
    | undefined;
  if (!row || !isValidGroupFolder(row.group_folder)) {
    return undefined;
  }
  return mapResponseFeedbackRow(row);
}

export function getResponseFeedbackByMessage(params: {
  chatJid: string;
  platformMessageId: string;
}): ResponseFeedbackRecord | undefined {
  const row = db
    .prepare(
      `
        SELECT *
        FROM response_feedback
        WHERE chat_jid = ? AND platform_message_id = ?
      `,
    )
    .get(params.chatJid, params.platformMessageId) as
    | Parameters<typeof mapResponseFeedbackRow>[0]
    | undefined;
  if (!row || !isValidGroupFolder(row.group_folder)) {
    return undefined;
  }
  return mapResponseFeedbackRow(row);
}

export function getResponseFeedbackByRemediationJob(params: {
  laneId: NonNullable<ResponseFeedbackRecord['remediationLaneId']>;
  jobId: string;
}): ResponseFeedbackRecord | undefined {
  const row = db
    .prepare(
      `
        SELECT *
        FROM response_feedback
        WHERE remediation_lane_id = ? AND remediation_job_id = ?
        ORDER BY updated_at DESC
        LIMIT 1
      `,
    )
    .get(params.laneId, params.jobId) as
    | Parameters<typeof mapResponseFeedbackRow>[0]
    | undefined;
  if (!row || !isValidGroupFolder(row.group_folder)) {
    return undefined;
  }
  return mapResponseFeedbackRow(row);
}

export function listRecentResponseFeedback(params: {
  chatJid?: string;
  status?: ResponseFeedbackRecord['status'];
  limit?: number;
} = {}): ResponseFeedbackRecord[] {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (params.chatJid) {
    clauses.push('chat_jid = ?');
    values.push(params.chatJid);
  }
  if (params.status) {
    clauses.push('status = ?');
    values.push(params.status);
  }
  const sql = [
    'SELECT *',
    'FROM response_feedback',
    clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    'ORDER BY updated_at DESC',
    'LIMIT ?',
  ]
    .filter(Boolean)
    .join('\n');
  values.push(Math.max(1, params.limit || 20));
  const rows = db.prepare(sql).all(...values) as Array<
    Parameters<typeof mapResponseFeedbackRow>[0]
  >;
  return rows
    .filter((row) => isValidGroupFolder(row.group_folder))
    .map((row) => mapResponseFeedbackRow(row));
}

export function updateResponseFeedback(
  feedbackId: string,
  updates: Partial<
    Omit<ResponseFeedbackRecord, 'feedbackId' | 'createdAt' | 'groupFolder' | 'chatJid' | 'channel'>
  >,
): ResponseFeedbackRecord {
  const existing = getResponseFeedback(feedbackId);
  if (!existing) {
    throw new Error(`No response feedback record found for ${feedbackId}.`);
  }
  const next: ResponseFeedbackRecord = {
    ...existing,
    ...updates,
    traceNotes:
      updates.traceNotes !== undefined ? updates.traceNotes : existing.traceNotes,
    linkedRefs:
      updates.linkedRefs !== undefined ? updates.linkedRefs : existing.linkedRefs,
    updatedAt: updates.updatedAt || new Date().toISOString(),
  };
  upsertResponseFeedback(next);
  return next;
}

export function prunePilotLoopData(cutoffIso: string): void {
  db.prepare('DELETE FROM pilot_issues WHERE created_at < ?').run(cutoffIso);
  db.prepare('DELETE FROM pilot_journey_events WHERE started_at < ?').run(
    cutoffIso,
  );
}

export function upsertProfileSubject(record: ProfileSubject): void {
  assertValidGroupFolder(record.groupFolder);
  db.prepare(
    `
      INSERT INTO profile_subjects (
        id,
        group_folder,
        kind,
        canonical_name,
        display_name,
        created_at,
        updated_at,
        disabled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        group_folder = excluded.group_folder,
        kind = excluded.kind,
        canonical_name = excluded.canonical_name,
        display_name = excluded.display_name,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        disabled_at = excluded.disabled_at
    `,
  ).run(
    record.id,
    record.groupFolder,
    record.kind,
    record.canonicalName,
    record.displayName,
    record.createdAt,
    record.updatedAt,
    record.disabledAt || null,
  );
}

export function getProfileSubject(id: string): ProfileSubject | undefined {
  const row = db
    .prepare(
      `
        SELECT *
        FROM profile_subjects
        WHERE id = ?
        LIMIT 1
      `,
    )
    .get(id) as
    | {
        id: string;
        group_folder: string;
        kind: ProfileSubject['kind'];
        canonical_name: string;
        display_name: string;
        created_at: string;
        updated_at: string;
        disabled_at: string | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.group_folder)) return undefined;
  return {
    id: row.id,
    groupFolder: row.group_folder,
    kind: row.kind,
    canonicalName: row.canonical_name,
    displayName: row.display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    disabledAt: row.disabled_at,
  };
}

export function getProfileSubjectByKey(
  groupFolder: string,
  kind: ProfileSubject['kind'],
  canonicalName: string,
): ProfileSubject | undefined {
  assertValidGroupFolder(groupFolder);
  const row = db
    .prepare(
      `
        SELECT *
        FROM profile_subjects
        WHERE group_folder = ?
          AND kind = ?
          AND canonical_name = ?
          AND disabled_at IS NULL
        LIMIT 1
      `,
    )
    .get(groupFolder, kind, canonicalName) as
    | {
        id: string;
        group_folder: string;
        kind: ProfileSubject['kind'];
        canonical_name: string;
        display_name: string;
        created_at: string;
        updated_at: string;
        disabled_at: string | null;
      }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    groupFolder: row.group_folder,
    kind: row.kind,
    canonicalName: row.canonical_name,
    displayName: row.display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    disabledAt: row.disabled_at,
  };
}

export function listProfileSubjectsForGroup(
  groupFolder: string,
): ProfileSubject[] {
  assertValidGroupFolder(groupFolder);
  const rows = db
    .prepare(
      `
        SELECT *
        FROM profile_subjects
        WHERE group_folder = ? AND disabled_at IS NULL
        ORDER BY kind ASC, display_name COLLATE NOCASE ASC
      `,
    )
    .all(groupFolder) as Array<{
    id: string;
    group_folder: string;
    kind: ProfileSubject['kind'];
    canonical_name: string;
    display_name: string;
    created_at: string;
    updated_at: string;
    disabled_at: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    groupFolder: row.group_folder,
    kind: row.kind,
    canonicalName: row.canonical_name,
    displayName: row.display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    disabledAt: row.disabled_at,
  }));
}

export function upsertProfileFact(record: ProfileFact): void {
  assertValidGroupFolder(record.groupFolder);
  db.prepare(
    `
      INSERT INTO profile_facts (
        id,
        group_folder,
        subject_id,
        category,
        fact_key,
        value_json,
        state,
        source_channel,
        source_summary,
        created_at,
        updated_at,
        decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(group_folder, subject_id, category, fact_key) DO UPDATE SET
        id = excluded.id,
        value_json = excluded.value_json,
        state = excluded.state,
        source_channel = excluded.source_channel,
        source_summary = excluded.source_summary,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        decided_at = excluded.decided_at
    `,
  ).run(
    record.id,
    record.groupFolder,
    record.subjectId,
    record.category,
    record.factKey,
    record.valueJson,
    record.state,
    record.sourceChannel,
    record.sourceSummary,
    record.createdAt,
    record.updatedAt,
    record.decidedAt || null,
  );
}

export function getProfileFact(id: string): ProfileFact | undefined {
  const row = db
    .prepare(
      `
        SELECT *
        FROM profile_facts
        WHERE id = ?
        LIMIT 1
      `,
    )
    .get(id) as
    | {
        id: string;
        group_folder: string;
        subject_id: string;
        category: ProfileFact['category'];
        fact_key: string;
        value_json: string;
        state: ProfileFact['state'];
        source_channel: string;
        source_summary: string;
        created_at: string;
        updated_at: string;
        decided_at: string | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.group_folder)) return undefined;
  return {
    id: row.id,
    groupFolder: row.group_folder,
    subjectId: row.subject_id,
    category: row.category,
    factKey: row.fact_key,
    valueJson: row.value_json,
    state: row.state,
    sourceChannel: row.source_channel,
    sourceSummary: row.source_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
  };
}

export function getProfileFactByKey(
  groupFolder: string,
  subjectId: string,
  category: ProfileFact['category'],
  factKey: string,
): ProfileFact | undefined {
  assertValidGroupFolder(groupFolder);
  const row = db
    .prepare(
      `
        SELECT *
        FROM profile_facts
        WHERE group_folder = ?
          AND subject_id = ?
          AND category = ?
          AND fact_key = ?
        LIMIT 1
      `,
    )
    .get(groupFolder, subjectId, category, factKey) as
    | {
        id: string;
        group_folder: string;
        subject_id: string;
        category: ProfileFact['category'];
        fact_key: string;
        value_json: string;
        state: ProfileFact['state'];
        source_channel: string;
        source_summary: string;
        created_at: string;
        updated_at: string;
        decided_at: string | null;
      }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    groupFolder: row.group_folder,
    subjectId: row.subject_id,
    category: row.category,
    factKey: row.fact_key,
    valueJson: row.value_json,
    state: row.state,
    sourceChannel: row.source_channel,
    sourceSummary: row.source_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
  };
}

export function updateProfileFactState(
  id: string,
  state: ProfileFact['state'],
  updatedAt: string,
  decidedAt: string | null = updatedAt,
): boolean {
  const result = db
    .prepare(
      `
        UPDATE profile_facts
        SET state = ?, updated_at = ?, decided_at = ?
        WHERE id = ?
      `,
    )
    .run(state, updatedAt, decidedAt, id);
  return result.changes === 1;
}

export function listProfileFactsForGroup(
  groupFolder: string,
  states?: ProfileFact['state'][],
): ProfileFactWithSubject[] {
  assertValidGroupFolder(groupFolder);
  const args: unknown[] = [groupFolder];
  const stateClause =
    states && states.length > 0
      ? `AND f.state IN (${states.map(() => '?').join(', ')})`
      : '';
  if (states) {
    args.push(...states);
  }

  const rows = db
    .prepare(
      `
        SELECT
          f.id,
          f.group_folder,
          f.subject_id,
          f.category,
          f.fact_key,
          f.value_json,
          f.state,
          f.source_channel,
          f.source_summary,
          f.created_at,
          f.updated_at,
          f.decided_at,
          s.kind AS subject_kind,
          s.canonical_name AS subject_canonical_name,
          s.display_name AS subject_display_name
        FROM profile_facts f
        JOIN profile_subjects s ON s.id = f.subject_id
        WHERE f.group_folder = ?
          AND s.disabled_at IS NULL
          ${stateClause}
        ORDER BY
          CASE f.state
            WHEN 'accepted' THEN 0
            WHEN 'proposed' THEN 1
            WHEN 'rejected' THEN 2
            ELSE 3
          END,
          f.updated_at DESC
      `,
    )
    .all(...args) as Array<{
    id: string;
    group_folder: string;
    subject_id: string;
    category: ProfileFact['category'];
    fact_key: string;
    value_json: string;
    state: ProfileFact['state'];
    source_channel: string;
    source_summary: string;
    created_at: string;
    updated_at: string;
    decided_at: string | null;
    subject_kind: ProfileFactWithSubject['subjectKind'];
    subject_canonical_name: string;
    subject_display_name: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    groupFolder: row.group_folder,
    subjectId: row.subject_id,
    category: row.category,
    factKey: row.fact_key,
    valueJson: row.value_json,
    state: row.state,
    sourceChannel: row.source_channel,
    sourceSummary: row.source_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
    subjectKind: row.subject_kind,
    subjectCanonicalName: row.subject_canonical_name,
    subjectDisplayName: row.subject_display_name,
  }));
}

function mapOperatingProfileRow(row: {
  profile_id: string;
  group_folder: string;
  status: OperatingProfileStatus;
  version: number;
  based_on_profile_id: string | null;
  intake_json: string;
  plan_json: string;
  source_channel: OperatingProfile['sourceChannel'];
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  superseded_at: string | null;
}): OperatingProfile {
  return {
    profileId: row.profile_id,
    groupFolder: row.group_folder,
    status: row.status,
    version: row.version,
    basedOnProfileId: row.based_on_profile_id,
    intakeJson: row.intake_json,
    planJson: row.plan_json,
    sourceChannel: row.source_channel,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    approvedAt: row.approved_at,
    supersededAt: row.superseded_at,
  };
}

function mapOperatingProfileSuggestionRow(row: {
  suggestion_id: string;
  group_folder: string;
  profile_id: string | null;
  title: string;
  summary: string;
  suggestion_json: string;
  state: OperatingProfileSuggestionState;
  source_channel: OperatingProfileSuggestion['sourceChannel'];
  created_at: string;
  updated_at: string;
  decided_at: string | null;
}): OperatingProfileSuggestion {
  return {
    suggestionId: row.suggestion_id,
    groupFolder: row.group_folder,
    profileId: row.profile_id,
    title: row.title,
    summary: row.summary,
    suggestionJson: row.suggestion_json,
    state: row.state,
    sourceChannel: row.source_channel,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
  };
}

function mapEverydayListGroupRow(row: {
  group_id: string;
  group_folder: string;
  operating_profile_id: string | null;
  title: string;
  kind: EverydayListGroupKind;
  scope: EverydayListScope;
  source_summary: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}): EverydayListGroup {
  return {
    groupId: row.group_id,
    groupFolder: row.group_folder,
    operatingProfileId: row.operating_profile_id,
    title: row.title,
    kind: row.kind,
    scope: row.scope,
    sourceSummary: row.source_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function mapEverydayListItemRow(row: {
  item_id: string;
  group_folder: string;
  group_id: string;
  operating_profile_id: string | null;
  title: string;
  item_kind: EverydayListItemKind;
  state: EverydayListItemState;
  scope: EverydayListScope;
  source_channel: EverydayListItem['sourceChannel'];
  source_summary: string;
  detail_json: string | null;
  linkage_json: string | null;
  due_at: string | null;
  scheduled_for: string | null;
  defer_until: string | null;
  recurrence_kind: EverydayListItem['recurrenceKind'];
  recurrence_interval: number;
  recurrence_days_json: string | null;
  recurrence_day_of_month: number | null;
  recurrence_anchor_at: string | null;
  recurrence_next_due_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}): EverydayListItem {
  return {
    itemId: row.item_id,
    groupFolder: row.group_folder,
    groupId: row.group_id,
    operatingProfileId: row.operating_profile_id,
    title: row.title,
    itemKind: row.item_kind,
    state: row.state,
    scope: row.scope,
    sourceChannel: row.source_channel,
    sourceSummary: row.source_summary,
    detailJson: row.detail_json,
    linkageJson: row.linkage_json,
    dueAt: row.due_at,
    scheduledFor: row.scheduled_for,
    deferUntil: row.defer_until,
    recurrenceKind: row.recurrence_kind || 'none',
    recurrenceInterval: row.recurrence_interval || 1,
    recurrenceDaysJson: row.recurrence_days_json,
    recurrenceDayOfMonth: row.recurrence_day_of_month,
    recurrenceAnchorAt: row.recurrence_anchor_at,
    recurrenceNextDueAt: row.recurrence_next_due_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export function upsertOperatingProfile(record: OperatingProfile): void {
  assertValidGroupFolder(record.groupFolder);
  db.prepare(
    `
      INSERT INTO operating_profiles (
        profile_id,
        group_folder,
        status,
        version,
        based_on_profile_id,
        intake_json,
        plan_json,
        source_channel,
        created_at,
        updated_at,
        approved_at,
        superseded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_id) DO UPDATE SET
        group_folder = excluded.group_folder,
        status = excluded.status,
        version = excluded.version,
        based_on_profile_id = excluded.based_on_profile_id,
        intake_json = excluded.intake_json,
        plan_json = excluded.plan_json,
        source_channel = excluded.source_channel,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        approved_at = excluded.approved_at,
        superseded_at = excluded.superseded_at
    `,
  ).run(
    record.profileId,
    record.groupFolder,
    record.status,
    record.version,
    record.basedOnProfileId || null,
    record.intakeJson,
    record.planJson,
    record.sourceChannel,
    record.createdAt,
    record.updatedAt,
    record.approvedAt || null,
    record.supersededAt || null,
  );
}

export function getOperatingProfile(
  profileId: string,
): OperatingProfile | undefined {
  const row = db
    .prepare(
      `
        SELECT *
        FROM operating_profiles
        WHERE profile_id = ?
        LIMIT 1
      `,
    )
    .get(profileId) as Parameters<typeof mapOperatingProfileRow>[0] | undefined;
  return row ? mapOperatingProfileRow(row) : undefined;
}

export function getActiveOperatingProfile(
  groupFolder: string,
): OperatingProfile | undefined {
  assertValidGroupFolder(groupFolder);
  const row = db
    .prepare(
      `
        SELECT *
        FROM operating_profiles
        WHERE group_folder = ?
          AND status = 'active'
        ORDER BY updated_at DESC
        LIMIT 1
      `,
    )
    .get(groupFolder) as Parameters<typeof mapOperatingProfileRow>[0] | undefined;
  return row ? mapOperatingProfileRow(row) : undefined;
}

export function listOperatingProfilesForGroup(
  groupFolder: string,
  statuses?: OperatingProfileStatus[],
): OperatingProfile[] {
  assertValidGroupFolder(groupFolder);
  const args: unknown[] = [groupFolder];
  const statusClause =
    statuses && statuses.length
      ? `AND status IN (${statuses.map(() => '?').join(', ')})`
      : '';
  if (statuses?.length) {
    args.push(...statuses);
  }
  const rows = db
    .prepare(
      `
        SELECT *
        FROM operating_profiles
        WHERE group_folder = ?
          ${statusClause}
        ORDER BY version DESC, updated_at DESC
      `,
    )
    .all(...args) as Array<Parameters<typeof mapOperatingProfileRow>[0]>;
  return rows.map(mapOperatingProfileRow);
}

export function supersedeActiveOperatingProfiles(
  groupFolder: string,
  now: string,
  exceptProfileId?: string,
): void {
  assertValidGroupFolder(groupFolder);
  if (exceptProfileId) {
    db.prepare(
      `
        UPDATE operating_profiles
        SET status = 'superseded',
            updated_at = ?,
            superseded_at = ?
        WHERE group_folder = ?
          AND status = 'active'
          AND profile_id != ?
      `,
    ).run(now, now, groupFolder, exceptProfileId);
    return;
  }

  db.prepare(
    `
      UPDATE operating_profiles
      SET status = 'superseded',
          updated_at = ?,
          superseded_at = ?
      WHERE group_folder = ?
        AND status = 'active'
    `,
  ).run(now, now, groupFolder);
}

export function upsertOperatingProfileSuggestion(
  record: OperatingProfileSuggestion,
): void {
  assertValidGroupFolder(record.groupFolder);
  db.prepare(
    `
      INSERT INTO operating_profile_suggestions (
        suggestion_id,
        group_folder,
        profile_id,
        title,
        summary,
        suggestion_json,
        state,
        source_channel,
        created_at,
        updated_at,
        decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(suggestion_id) DO UPDATE SET
        group_folder = excluded.group_folder,
        profile_id = excluded.profile_id,
        title = excluded.title,
        summary = excluded.summary,
        suggestion_json = excluded.suggestion_json,
        state = excluded.state,
        source_channel = excluded.source_channel,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        decided_at = excluded.decided_at
    `,
  ).run(
    record.suggestionId,
    record.groupFolder,
    record.profileId || null,
    record.title,
    record.summary,
    record.suggestionJson,
    record.state,
    record.sourceChannel,
    record.createdAt,
    record.updatedAt,
    record.decidedAt || null,
  );
}

export function listOperatingProfileSuggestions(
  groupFolder: string,
  states?: OperatingProfileSuggestionState[],
): OperatingProfileSuggestion[] {
  assertValidGroupFolder(groupFolder);
  const args: unknown[] = [groupFolder];
  const stateClause =
    states && states.length
      ? `AND state IN (${states.map(() => '?').join(', ')})`
      : '';
  if (states?.length) {
    args.push(...states);
  }
  const rows = db
    .prepare(
      `
        SELECT *
        FROM operating_profile_suggestions
        WHERE group_folder = ?
          ${stateClause}
        ORDER BY updated_at DESC
      `,
    )
    .all(...args) as Array<Parameters<typeof mapOperatingProfileSuggestionRow>[0]>;
  return rows.map(mapOperatingProfileSuggestionRow);
}

export function updateOperatingProfileSuggestionState(
  suggestionId: string,
  state: OperatingProfileSuggestionState,
  updatedAt: string,
  decidedAt: string | null = updatedAt,
): boolean {
  const result = db
    .prepare(
      `
        UPDATE operating_profile_suggestions
        SET state = ?, updated_at = ?, decided_at = ?
        WHERE suggestion_id = ?
      `,
    )
    .run(state, updatedAt, decidedAt, suggestionId);
  return result.changes === 1;
}

export function upsertEverydayListGroup(record: EverydayListGroup): void {
  assertValidGroupFolder(record.groupFolder);
  db.prepare(
    `
      INSERT INTO everyday_list_groups (
        group_id,
        group_folder,
        operating_profile_id,
        title,
        kind,
        scope,
        source_summary,
        created_at,
        updated_at,
        archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(group_id) DO UPDATE SET
        group_folder = excluded.group_folder,
        operating_profile_id = excluded.operating_profile_id,
        title = excluded.title,
        kind = excluded.kind,
        scope = excluded.scope,
        source_summary = excluded.source_summary,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        archived_at = excluded.archived_at
    `,
  ).run(
    record.groupId,
    record.groupFolder,
    record.operatingProfileId || null,
    record.title,
    record.kind,
    record.scope,
    record.sourceSummary || null,
    record.createdAt,
    record.updatedAt,
    record.archivedAt || null,
  );
}

export function getEverydayListGroup(
  groupId: string,
): EverydayListGroup | undefined {
  const row = db
    .prepare(
      `
        SELECT *
        FROM everyday_list_groups
        WHERE group_id = ?
        LIMIT 1
      `,
    )
    .get(groupId) as Parameters<typeof mapEverydayListGroupRow>[0] | undefined;
  return row ? mapEverydayListGroupRow(row) : undefined;
}

export function findEverydayListGroupByTitle(
  groupFolder: string,
  title: string,
): EverydayListGroup | undefined {
  assertValidGroupFolder(groupFolder);
  const row = db
    .prepare(
      `
        SELECT *
        FROM everyday_list_groups
        WHERE group_folder = ?
          AND lower(title) = lower(?)
          AND archived_at IS NULL
        LIMIT 1
      `,
    )
    .get(groupFolder, title) as Parameters<typeof mapEverydayListGroupRow>[0] | undefined;
  return row ? mapEverydayListGroupRow(row) : undefined;
}

export function findEverydayListGroupByKind(
  groupFolder: string,
  kind: EverydayListGroupKind,
  scope?: EverydayListScope,
): EverydayListGroup | undefined {
  assertValidGroupFolder(groupFolder);
  const row = db
    .prepare(
      `
        SELECT *
        FROM everyday_list_groups
        WHERE group_folder = ?
          AND kind = ?
          ${scope ? 'AND scope = ?' : ''}
          AND archived_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 1
      `,
    )
    .get(
      ...(scope ? [groupFolder, kind, scope] : [groupFolder, kind]),
    ) as Parameters<typeof mapEverydayListGroupRow>[0] | undefined;
  return row ? mapEverydayListGroupRow(row) : undefined;
}

export function listEverydayListGroups(
  groupFolder: string,
  options: { includeArchived?: boolean } = {},
): EverydayListGroup[] {
  assertValidGroupFolder(groupFolder);
  const clauses = ['group_folder = ?'];
  if (!options.includeArchived) {
    clauses.push('archived_at IS NULL');
  }
  const rows = db
    .prepare(
      `
        SELECT *
        FROM everyday_list_groups
        WHERE ${clauses.join(' AND ')}
        ORDER BY title COLLATE NOCASE ASC
      `,
    )
    .all(groupFolder) as Array<Parameters<typeof mapEverydayListGroupRow>[0]>;
  return rows.map(mapEverydayListGroupRow);
}

export function upsertEverydayListItem(record: EverydayListItem): void {
  assertValidGroupFolder(record.groupFolder);
  db.prepare(
    `
      INSERT INTO everyday_list_items (
        item_id,
        group_folder,
        group_id,
        operating_profile_id,
        title,
        item_kind,
        state,
        scope,
        source_channel,
        source_summary,
        detail_json,
        linkage_json,
        due_at,
        scheduled_for,
        defer_until,
        recurrence_kind,
        recurrence_interval,
        recurrence_days_json,
        recurrence_day_of_month,
        recurrence_anchor_at,
        recurrence_next_due_at,
        created_at,
        updated_at,
        completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET
        group_folder = excluded.group_folder,
        group_id = excluded.group_id,
        operating_profile_id = excluded.operating_profile_id,
        title = excluded.title,
        item_kind = excluded.item_kind,
        state = excluded.state,
        scope = excluded.scope,
        source_channel = excluded.source_channel,
        source_summary = excluded.source_summary,
        detail_json = excluded.detail_json,
        linkage_json = excluded.linkage_json,
        due_at = excluded.due_at,
        scheduled_for = excluded.scheduled_for,
        defer_until = excluded.defer_until,
        recurrence_kind = excluded.recurrence_kind,
        recurrence_interval = excluded.recurrence_interval,
        recurrence_days_json = excluded.recurrence_days_json,
        recurrence_day_of_month = excluded.recurrence_day_of_month,
        recurrence_anchor_at = excluded.recurrence_anchor_at,
        recurrence_next_due_at = excluded.recurrence_next_due_at,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at
    `,
  ).run(
    record.itemId,
    record.groupFolder,
    record.groupId,
    record.operatingProfileId || null,
    record.title,
    record.itemKind,
    record.state,
    record.scope,
    record.sourceChannel,
    record.sourceSummary,
    record.detailJson || null,
    record.linkageJson || null,
    record.dueAt || null,
    record.scheduledFor || null,
    record.deferUntil || null,
    record.recurrenceKind || 'none',
    record.recurrenceInterval || 1,
    record.recurrenceDaysJson || null,
    record.recurrenceDayOfMonth || null,
    record.recurrenceAnchorAt || null,
    record.recurrenceNextDueAt || null,
    record.createdAt,
    record.updatedAt,
    record.completedAt || null,
  );
}

export function getEverydayListItem(
  itemId: string,
): EverydayListItem | undefined {
  const row = db
    .prepare(
      `
        SELECT *
        FROM everyday_list_items
        WHERE item_id = ?
        LIMIT 1
      `,
    )
    .get(itemId) as Parameters<typeof mapEverydayListItemRow>[0] | undefined;
  return row ? mapEverydayListItemRow(row) : undefined;
}

export function listEverydayListItems(
  groupFolder: string,
  options: {
    groupId?: string;
    groupKind?: EverydayListGroupKind;
    states?: EverydayListItemState[];
    includeDone?: boolean;
    limit?: number;
    scope?: EverydayListScope;
  } = {},
): EverydayListItem[] {
  assertValidGroupFolder(groupFolder);
  const clauses = ['i.group_folder = ?'];
  const args: unknown[] = [groupFolder];

  if (options.groupId) {
    clauses.push('i.group_id = ?');
    args.push(options.groupId);
  }
  if (options.groupKind) {
    clauses.push('g.kind = ?');
    args.push(options.groupKind);
  }
  if (options.scope) {
    clauses.push('i.scope = ?');
    args.push(options.scope);
  }
  if (options.states?.length) {
    clauses.push(`i.state IN (${options.states.map(() => '?').join(', ')})`);
    args.push(...options.states);
  } else if (!options.includeDone) {
    clauses.push(`i.state NOT IN ('done')`);
  }

  const limitClause =
    typeof options.limit === 'number' && options.limit > 0 ? 'LIMIT ?' : '';
  if (limitClause) {
    args.push(options.limit as number);
  }

  const rows = db
    .prepare(
      `
        SELECT i.*
        FROM everyday_list_items i
        JOIN everyday_list_groups g ON g.group_id = i.group_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY
          CASE i.state
            WHEN 'open' THEN 0
            WHEN 'snoozed' THEN 1
            WHEN 'deferred' THEN 2
            ELSE 3
          END,
          COALESCE(i.due_at, i.scheduled_for, i.defer_until, i.updated_at) ASC,
          i.updated_at DESC
        ${limitClause}
      `,
    )
    .all(...args) as Array<Parameters<typeof mapEverydayListItemRow>[0]>;

  return rows.map(mapEverydayListItemRow);
}

export function updateEverydayListItem(
  itemId: string,
  patch: Partial<
    Omit<
      EverydayListItem,
      'itemId' | 'groupFolder' | 'groupId' | 'createdAt' | 'sourceChannel'
    >
  > & { groupId?: string },
): boolean {
  const existing = getEverydayListItem(itemId);
  if (!existing) return false;
  upsertEverydayListItem({
    ...existing,
    ...patch,
    updatedAt: patch.updatedAt || new Date().toISOString(),
  });
  return true;
}

export function deleteEverydayListItem(itemId: string): boolean {
  const result = db
    .prepare(
      `
        DELETE FROM everyday_list_items
        WHERE item_id = ?
      `,
    )
    .run(itemId);
  return result.changes === 1;
}

function mapKnowledgeSourceRow(row: {
  source_id: string;
  group_folder: string;
  source_type: KnowledgeSourceRecord['sourceType'];
  title: string;
  short_summary: string;
  content_ref: string | null;
  normalized_text: string;
  tags_json: string;
  scope: KnowledgeScope;
  sensitivity: KnowledgeSensitivity;
  ingestion_state: KnowledgeSourceRecord['ingestionState'];
  index_state: KnowledgeIndexState;
  source_channel: KnowledgeSourceRecord['sourceChannel'];
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  disabled_at: string | null;
  deleted_at: string | null;
}): KnowledgeSourceRecord {
  return {
    sourceId: row.source_id,
    groupFolder: row.group_folder,
    sourceType: row.source_type,
    title: row.title,
    shortSummary: row.short_summary,
    contentRef: row.content_ref,
    normalizedText: row.normalized_text,
    tags: parseStringArrayJson(row.tags_json),
    scope: row.scope,
    sensitivity: row.sensitivity,
    ingestionState: row.ingestion_state,
    indexState: row.index_state,
    sourceChannel: row.source_channel,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    disabledAt: row.disabled_at,
    deletedAt: row.deleted_at,
  };
}

function mapKnowledgeChunkRow(row: {
  chunk_id: string;
  source_id: string;
  chunk_index: number;
  chunk_text: string;
  char_length: number;
  created_at: string;
}): KnowledgeChunkRecord {
  return {
    chunkId: row.chunk_id,
    sourceId: row.source_id,
    chunkIndex: row.chunk_index,
    chunkText: row.chunk_text,
    charLength: row.char_length,
    createdAt: row.created_at,
  };
}

export function upsertKnowledgeSource(record: KnowledgeSourceRecord): void {
  assertValidGroupFolder(record.groupFolder);
  db.prepare(
    `
      INSERT INTO knowledge_sources (
        source_id,
        group_folder,
        source_type,
        title,
        short_summary,
        content_ref,
        normalized_text,
        tags_json,
        scope,
        sensitivity,
        ingestion_state,
        index_state,
        source_channel,
        created_at,
        updated_at,
        last_used_at,
        disabled_at,
        deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        group_folder = excluded.group_folder,
        source_type = excluded.source_type,
        title = excluded.title,
        short_summary = excluded.short_summary,
        content_ref = excluded.content_ref,
        normalized_text = excluded.normalized_text,
        tags_json = excluded.tags_json,
        scope = excluded.scope,
        sensitivity = excluded.sensitivity,
        ingestion_state = excluded.ingestion_state,
        index_state = excluded.index_state,
        source_channel = excluded.source_channel,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        last_used_at = excluded.last_used_at,
        disabled_at = excluded.disabled_at,
        deleted_at = excluded.deleted_at
    `,
  ).run(
    record.sourceId,
    record.groupFolder,
    record.sourceType,
    record.title,
    record.shortSummary,
    record.contentRef || null,
    record.normalizedText,
    JSON.stringify(record.tags || []),
    record.scope,
    record.sensitivity,
    record.ingestionState,
    record.indexState,
    record.sourceChannel || null,
    record.createdAt,
    record.updatedAt,
    record.lastUsedAt || null,
    record.disabledAt || null,
    record.deletedAt || null,
  );
}

export function getKnowledgeSource(
  sourceId: string,
): KnowledgeSourceRecord | undefined {
  const row = db
    .prepare(
      `
        SELECT *
        FROM knowledge_sources
        WHERE source_id = ?
        LIMIT 1
      `,
    )
    .get(sourceId) as
    | {
        source_id: string;
        group_folder: string;
        source_type: KnowledgeSourceRecord['sourceType'];
        title: string;
        short_summary: string;
        content_ref: string | null;
        normalized_text: string;
        tags_json: string;
        scope: KnowledgeScope;
        sensitivity: KnowledgeSensitivity;
        ingestion_state: KnowledgeSourceRecord['ingestionState'];
        index_state: KnowledgeIndexState;
        source_channel: KnowledgeSourceRecord['sourceChannel'];
        created_at: string;
        updated_at: string;
        last_used_at: string | null;
        disabled_at: string | null;
        deleted_at: string | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.group_folder)) return undefined;
  return mapKnowledgeSourceRow(row);
}

export function listKnowledgeSourcesForGroup(
  groupFolder: string,
  options: {
    includeDisabled?: boolean;
    includeDeleted?: boolean;
    limit?: number;
    query?: string;
  } = {},
): KnowledgeSourceRecord[] {
  assertValidGroupFolder(groupFolder);
  const clauses = ['group_folder = ?'];
  const args: unknown[] = [groupFolder];

  if (!options.includeDisabled) {
    clauses.push('disabled_at IS NULL');
  }
  if (!options.includeDeleted) {
    clauses.push('deleted_at IS NULL');
    clauses.push("ingestion_state != 'deleted'");
  }
  if (options.query?.trim()) {
    const like = `%${options.query.trim()}%`;
    clauses.push(
      '(title LIKE ? COLLATE NOCASE OR short_summary LIKE ? COLLATE NOCASE OR tags_json LIKE ? COLLATE NOCASE)',
    );
    args.push(like, like, like);
  }

  args.push(Math.max(1, options.limit || 25));
  const rows = db
    .prepare(
      `
        SELECT *
        FROM knowledge_sources
        WHERE ${clauses.join(' AND ')}
        ORDER BY
          CASE WHEN last_used_at IS NULL THEN 1 ELSE 0 END ASC,
          last_used_at DESC,
          updated_at DESC
        LIMIT ?
      `,
    )
    .all(...args) as Array<{
    source_id: string;
    group_folder: string;
    source_type: KnowledgeSourceRecord['sourceType'];
    title: string;
    short_summary: string;
    content_ref: string | null;
    normalized_text: string;
    tags_json: string;
    scope: KnowledgeScope;
    sensitivity: KnowledgeSensitivity;
    ingestion_state: KnowledgeSourceRecord['ingestionState'];
    index_state: KnowledgeIndexState;
    source_channel: KnowledgeSourceRecord['sourceChannel'];
    created_at: string;
    updated_at: string;
    last_used_at: string | null;
    disabled_at: string | null;
    deleted_at: string | null;
  }>;

  return rows.map((row) => mapKnowledgeSourceRow(row));
}

export function listKnowledgeSourcesByIds(
  groupFolder: string,
  sourceIds: string[],
): KnowledgeSourceRecord[] {
  assertValidGroupFolder(groupFolder);
  if (sourceIds.length === 0) return [];
  const placeholders = sourceIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `
        SELECT *
        FROM knowledge_sources
        WHERE group_folder = ?
          AND source_id IN (${placeholders})
          AND disabled_at IS NULL
          AND deleted_at IS NULL
          AND ingestion_state != 'deleted'
      `,
    )
    .all(groupFolder, ...sourceIds) as Array<{
    source_id: string;
    group_folder: string;
    source_type: KnowledgeSourceRecord['sourceType'];
    title: string;
    short_summary: string;
    content_ref: string | null;
    normalized_text: string;
    tags_json: string;
    scope: KnowledgeScope;
    sensitivity: KnowledgeSensitivity;
    ingestion_state: KnowledgeSourceRecord['ingestionState'];
    index_state: KnowledgeIndexState;
    source_channel: KnowledgeSourceRecord['sourceChannel'];
    created_at: string;
    updated_at: string;
    last_used_at: string | null;
    disabled_at: string | null;
    deleted_at: string | null;
  }>;

  return rows.map((row) => mapKnowledgeSourceRow(row));
}

export function listKnowledgeChunksForSource(
  sourceId: string,
): KnowledgeChunkRecord[] {
  const rows = db
    .prepare(
      `
        SELECT *
        FROM knowledge_chunks
        WHERE source_id = ?
        ORDER BY chunk_index ASC
      `,
    )
    .all(sourceId) as Array<{
    chunk_id: string;
    source_id: string;
    chunk_index: number;
    chunk_text: string;
    char_length: number;
    created_at: string;
  }>;

  return rows.map((row) => mapKnowledgeChunkRow(row));
}

export function replaceKnowledgeSourceChunks(
  sourceId: string,
  source: Pick<KnowledgeSourceRecord, 'title' | 'tags' | 'updatedAt'>,
  chunks: KnowledgeChunkRecord[],
): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM knowledge_chunks WHERE source_id = ?').run(
      sourceId,
    );
    db.prepare('DELETE FROM knowledge_chunks_fts WHERE source_id = ?').run(
      sourceId,
    );

    const insertChunk = db.prepare(
      `
        INSERT INTO knowledge_chunks (
          chunk_id,
          source_id,
          chunk_index,
          chunk_text,
          char_length,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
    );
    const insertFts = db.prepare(
      `
        INSERT INTO knowledge_chunks_fts (
          chunk_id,
          source_id,
          title,
          tags,
          content
        ) VALUES (?, ?, ?, ?, ?)
      `,
    );

    for (const chunk of chunks) {
      insertChunk.run(
        chunk.chunkId,
        chunk.sourceId,
        chunk.chunkIndex,
        chunk.chunkText,
        chunk.charLength,
        chunk.createdAt,
      );
      insertFts.run(
        chunk.chunkId,
        chunk.sourceId,
        source.title,
        source.tags.join(' '),
        chunk.chunkText,
      );
    }

    db.prepare(
      `
        UPDATE knowledge_sources
        SET index_state = 'indexed',
            updated_at = ?,
            disabled_at = NULL,
            deleted_at = CASE
              WHEN ingestion_state = 'deleted' THEN deleted_at
              ELSE NULL
            END
        WHERE source_id = ?
      `,
    ).run(source.updatedAt, sourceId);
  });

  tx();
}

export function searchKnowledgeChunks(params: {
  groupFolder: string;
  matchQuery: string;
  requestedSourceIds?: string[];
  limit?: number;
}): KnowledgeRetrievalHit[] {
  assertValidGroupFolder(params.groupFolder);
  const clauses = [
    'knowledge_chunks_fts MATCH ?',
    's.group_folder = ?',
    "s.ingestion_state = 'ready'",
    "s.index_state = 'indexed'",
    's.disabled_at IS NULL',
    's.deleted_at IS NULL',
  ];
  const args: unknown[] = [params.matchQuery, params.groupFolder];

  if (params.requestedSourceIds?.length) {
    clauses.push(
      `s.source_id IN (${params.requestedSourceIds.map(() => '?').join(', ')})`,
    );
    args.push(...params.requestedSourceIds);
  }

  args.push(Math.max(1, params.limit || 8));

  const rows = db
    .prepare(
      `
        SELECT
          c.chunk_id,
          c.chunk_index,
          c.chunk_text,
          s.source_id,
          s.title,
          s.source_type,
          s.scope,
          s.sensitivity,
          s.tags_json,
          bm25(knowledge_chunks_fts, 5.0, 2.0, 1.0) AS lexical_rank
        FROM knowledge_chunks_fts
        JOIN knowledge_chunks c ON c.chunk_id = knowledge_chunks_fts.chunk_id
        JOIN knowledge_sources s ON s.source_id = c.source_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY lexical_rank ASC, c.chunk_index ASC
        LIMIT ?
      `,
    )
    .all(...args) as Array<{
    chunk_id: string;
    chunk_index: number;
    chunk_text: string;
    source_id: string;
    title: string;
    source_type: KnowledgeRetrievalHit['sourceType'];
    scope: KnowledgeScope;
    sensitivity: KnowledgeSensitivity;
    tags_json: string;
    lexical_rank: number;
  }>;

  return rows.map((row) => {
    const tags = parseStringArrayJson(row.tags_json);
    const queryLower = params.matchQuery.toLowerCase();
    const titleLower = row.title.toLowerCase();
    const tagsLower = tags.join(' ').toLowerCase();
    const excerpt =
      row.chunk_text.length > 240
        ? `${row.chunk_text.slice(0, 237).trimEnd()}...`
        : row.chunk_text;
    const matchReason = titleLower.includes(
      queryLower.replace(/\s+or\s+/g, ' '),
    )
      ? 'matched source title'
      : tagsLower &&
          queryLower
            .split(/\s+or\s+/)
            .some((token) => tagsLower.includes(token))
        ? 'matched source tags'
        : 'matched saved content';
    return {
      sourceId: row.source_id,
      sourceTitle: row.title,
      sourceType: row.source_type,
      scope: row.scope,
      sensitivity: row.sensitivity,
      chunkId: row.chunk_id,
      chunkIndex: row.chunk_index,
      excerpt,
      retrievalScore: Number(
        (1 / (1 + Math.max(0, row.lexical_rank || 0))).toFixed(3),
      ),
      matchReason,
      tags,
    };
  });
}

export function touchKnowledgeSourcesLastUsed(
  sourceIds: string[],
  usedAt: string,
): void {
  if (sourceIds.length === 0) return;
  const tx = db.transaction((ids: string[]) => {
    const statement = db.prepare(
      `
        UPDATE knowledge_sources
        SET last_used_at = ?, updated_at = MAX(updated_at, ?)
        WHERE source_id = ?
      `,
    );
    for (const sourceId of ids) {
      statement.run(usedAt, usedAt, sourceId);
    }
  });
  tx(sourceIds);
}

export function disableKnowledgeSource(
  sourceId: string,
  updatedAt: string,
): boolean {
  const result = db
    .prepare(
      `
        UPDATE knowledge_sources
        SET index_state = 'disabled',
            disabled_at = ?,
            updated_at = ?
        WHERE source_id = ?
          AND deleted_at IS NULL
      `,
    )
    .run(updatedAt, updatedAt, sourceId);
  return result.changes === 1;
}

export function markKnowledgeSourceDeleted(
  sourceId: string,
  updatedAt: string,
): boolean {
  const tx = db.transaction((id: string, now: string) => {
    const result = db
      .prepare(
        `
          UPDATE knowledge_sources
          SET ingestion_state = 'deleted',
              index_state = 'disabled',
              deleted_at = ?,
              updated_at = ?
          WHERE source_id = ?
        `,
      )
      .run(now, now, id);
    db.prepare('DELETE FROM knowledge_chunks WHERE source_id = ?').run(id);
    db.prepare('DELETE FROM knowledge_chunks_fts WHERE source_id = ?').run(id);
    return result.changes === 1;
  });

  return tx(sourceId, updatedAt);
}

function mapRitualProfileRow(row: {
  id: string;
  group_folder: string;
  ritual_type: RitualProfile['ritualType'];
  enabled: number;
  trigger_style: RitualProfile['triggerStyle'];
  scope: RitualProfile['scope'];
  timing_json: string;
  tone_style: RitualProfile['toneStyle'];
  source_inputs_json: string;
  last_run_at: string | null;
  next_due_at: string | null;
  opt_in_state: RitualProfile['optInState'];
  linked_task_id: string | null;
  created_at: string;
  updated_at: string;
}): RitualProfile {
  return {
    id: row.id,
    groupFolder: row.group_folder,
    ritualType: row.ritual_type,
    enabled: row.enabled === 1,
    triggerStyle: row.trigger_style,
    scope: row.scope,
    timing: parseJsonObject(row.timing_json),
    toneStyle: row.tone_style,
    sourceInputs: parseStringArrayJson(
      row.source_inputs_json,
    ) as RitualProfile['sourceInputs'],
    lastRunAt: row.last_run_at,
    nextDueAt: row.next_due_at,
    optInState: row.opt_in_state,
    linkedTaskId: row.linked_task_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function upsertRitualProfile(record: RitualProfile): void {
  assertValidGroupFolder(record.groupFolder);
  db.prepare(
    `
      INSERT INTO ritual_profiles (
        id,
        group_folder,
        ritual_type,
        enabled,
        trigger_style,
        scope,
        timing_json,
        tone_style,
        source_inputs_json,
        last_run_at,
        next_due_at,
        opt_in_state,
        linked_task_id,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        group_folder = excluded.group_folder,
        ritual_type = excluded.ritual_type,
        enabled = excluded.enabled,
        trigger_style = excluded.trigger_style,
        scope = excluded.scope,
        timing_json = excluded.timing_json,
        tone_style = excluded.tone_style,
        source_inputs_json = excluded.source_inputs_json,
        last_run_at = excluded.last_run_at,
        next_due_at = excluded.next_due_at,
        opt_in_state = excluded.opt_in_state,
        linked_task_id = excluded.linked_task_id,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  ).run(
    record.id,
    record.groupFolder,
    record.ritualType,
    record.enabled ? 1 : 0,
    record.triggerStyle,
    record.scope,
    JSON.stringify(record.timing || {}),
    record.toneStyle,
    JSON.stringify(record.sourceInputs || []),
    record.lastRunAt || null,
    record.nextDueAt || null,
    record.optInState,
    record.linkedTaskId || null,
    record.createdAt,
    record.updatedAt,
  );
}

export function getRitualProfileByType(
  groupFolder: string,
  ritualType: RitualProfile['ritualType'],
): RitualProfile | undefined {
  assertValidGroupFolder(groupFolder);
  const row = db
    .prepare(
      `
        SELECT *
        FROM ritual_profiles
        WHERE group_folder = ?
          AND ritual_type = ?
        LIMIT 1
      `,
    )
    .get(groupFolder, ritualType) as
    | {
        id: string;
        group_folder: string;
        ritual_type: RitualProfile['ritualType'];
        enabled: number;
        trigger_style: RitualProfile['triggerStyle'];
        scope: RitualProfile['scope'];
        timing_json: string;
        tone_style: RitualProfile['toneStyle'];
        source_inputs_json: string;
        last_run_at: string | null;
        next_due_at: string | null;
        opt_in_state: RitualProfile['optInState'];
        linked_task_id: string | null;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  if (!row || !isValidGroupFolder(row.group_folder)) return undefined;
  return mapRitualProfileRow(row);
}

export function listRitualProfilesForGroup(
  groupFolder: string,
): RitualProfile[] {
  assertValidGroupFolder(groupFolder);
  const rows = db
    .prepare(
      `
        SELECT *
        FROM ritual_profiles
        WHERE group_folder = ?
        ORDER BY updated_at DESC, ritual_type ASC
      `,
    )
    .all(groupFolder) as Array<{
    id: string;
    group_folder: string;
    ritual_type: RitualProfile['ritualType'];
    enabled: number;
    trigger_style: RitualProfile['triggerStyle'];
    scope: RitualProfile['scope'];
    timing_json: string;
    tone_style: RitualProfile['toneStyle'];
    source_inputs_json: string;
    last_run_at: string | null;
    next_due_at: string | null;
    opt_in_state: RitualProfile['optInState'];
    linked_task_id: string | null;
    created_at: string;
    updated_at: string;
  }>;
  return rows
    .filter((row) => isValidGroupFolder(row.group_folder))
    .map((row) => mapRitualProfileRow(row));
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseStringArrayJson(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function mapLifeThreadRow(row: {
  id: string;
  group_folder: string;
  title: string;
  category: LifeThread['category'];
  status: LifeThread['status'];
  scope: LifeThread['scope'];
  related_subject_ids_json: string;
  context_tags_json: string;
  summary: string;
  next_action: string | null;
  next_followup_at: string | null;
  source_kind: LifeThread['sourceKind'];
  confidence_kind: LifeThread['confidenceKind'];
  user_confirmed: number;
  sensitivity: LifeThread['sensitivity'];
  surface_mode: LifeThread['surfaceMode'];
  followthrough_mode: LifeThread['followthroughMode'];
  last_surfaced_at: string | null;
  snoozed_until: string | null;
  linked_task_id: string | null;
  merged_into_thread_id: string | null;
  created_at: string;
  last_updated_at: string;
  last_used_at: string | null;
}): LifeThread {
  return {
    id: row.id,
    groupFolder: row.group_folder,
    title: row.title,
    category: row.category,
    status: row.status,
    scope: row.scope,
    relatedSubjectIds: parseStringArrayJson(row.related_subject_ids_json),
    contextTags: parseStringArrayJson(row.context_tags_json),
    summary: row.summary,
    nextAction: row.next_action,
    nextFollowupAt: row.next_followup_at,
    sourceKind: row.source_kind,
    confidenceKind: row.confidence_kind,
    userConfirmed: row.user_confirmed === 1,
    sensitivity: row.sensitivity,
    surfaceMode: row.surface_mode,
    followthroughMode: row.followthrough_mode,
    lastSurfacedAt: row.last_surfaced_at,
    snoozedUntil: row.snoozed_until,
    linkedTaskId: row.linked_task_id,
    mergedIntoThreadId: row.merged_into_thread_id,
    createdAt: row.created_at,
    lastUpdatedAt: row.last_updated_at,
    lastUsedAt: row.last_used_at,
  };
}

export function upsertLifeThread(record: LifeThread): void {
  assertValidGroupFolder(record.groupFolder);
  db.prepare(
    `
      INSERT INTO life_threads (
        id,
        group_folder,
        title,
        category,
        status,
        scope,
        related_subject_ids_json,
        context_tags_json,
        summary,
        next_action,
        next_followup_at,
        source_kind,
        confidence_kind,
        user_confirmed,
        sensitivity,
        surface_mode,
        followthrough_mode,
        last_surfaced_at,
        snoozed_until,
        linked_task_id,
        merged_into_thread_id,
        created_at,
        last_updated_at,
        last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        group_folder = excluded.group_folder,
        title = excluded.title,
        category = excluded.category,
        status = excluded.status,
        scope = excluded.scope,
        related_subject_ids_json = excluded.related_subject_ids_json,
        context_tags_json = excluded.context_tags_json,
        summary = excluded.summary,
        next_action = excluded.next_action,
        next_followup_at = excluded.next_followup_at,
        source_kind = excluded.source_kind,
        confidence_kind = excluded.confidence_kind,
        user_confirmed = excluded.user_confirmed,
        sensitivity = excluded.sensitivity,
        surface_mode = excluded.surface_mode,
        followthrough_mode = excluded.followthrough_mode,
        last_surfaced_at = excluded.last_surfaced_at,
        snoozed_until = excluded.snoozed_until,
        linked_task_id = excluded.linked_task_id,
        merged_into_thread_id = excluded.merged_into_thread_id,
        created_at = excluded.created_at,
        last_updated_at = excluded.last_updated_at,
        last_used_at = excluded.last_used_at
    `,
  ).run(
    record.id,
    record.groupFolder,
    record.title,
    record.category,
    record.status,
    record.scope,
    JSON.stringify(record.relatedSubjectIds || []),
    JSON.stringify(record.contextTags || []),
    record.summary,
    record.nextAction || null,
    record.nextFollowupAt || null,
    record.sourceKind,
    record.confidenceKind,
    record.userConfirmed ? 1 : 0,
    record.sensitivity,
    record.surfaceMode,
    record.followthroughMode,
    record.lastSurfacedAt || null,
    record.snoozedUntil || null,
    record.linkedTaskId || null,
    record.mergedIntoThreadId || null,
    record.createdAt,
    record.lastUpdatedAt,
    record.lastUsedAt || null,
  );
}

export function getLifeThread(id: string): LifeThread | undefined {
  const row = db
    .prepare(
      `
        SELECT *
        FROM life_threads
        WHERE id = ?
        LIMIT 1
      `,
    )
    .get(id) as
    | {
        id: string;
        group_folder: string;
        title: string;
        category: LifeThread['category'];
        status: LifeThread['status'];
        scope: LifeThread['scope'];
        related_subject_ids_json: string;
        context_tags_json: string;
        summary: string;
        next_action: string | null;
        next_followup_at: string | null;
        source_kind: LifeThread['sourceKind'];
        confidence_kind: LifeThread['confidenceKind'];
        user_confirmed: number;
        sensitivity: LifeThread['sensitivity'];
        surface_mode: LifeThread['surfaceMode'];
        followthrough_mode: LifeThread['followthroughMode'];
        last_surfaced_at: string | null;
        snoozed_until: string | null;
        linked_task_id: string | null;
        merged_into_thread_id: string | null;
        created_at: string;
        last_updated_at: string;
        last_used_at: string | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.group_folder)) return undefined;
  return mapLifeThreadRow(row);
}

export function listLifeThreadsForGroup(
  groupFolder: string,
  statuses?: LifeThread['status'][],
): LifeThread[] {
  assertValidGroupFolder(groupFolder);
  const args: unknown[] = [groupFolder];
  const statusClause =
    statuses && statuses.length > 0
      ? `AND status IN (${statuses.map(() => '?').join(', ')})`
      : '';
  if (statuses && statuses.length > 0) {
    args.push(...statuses);
  }

  const rows = db
    .prepare(
      `
        SELECT *
        FROM life_threads
        WHERE group_folder = ?
          ${statusClause}
        ORDER BY
          CASE status
            WHEN 'active' THEN 0
            WHEN 'paused' THEN 1
            WHEN 'closed' THEN 2
            ELSE 3
          END,
          last_updated_at DESC,
          title COLLATE NOCASE ASC
      `,
    )
    .all(...args) as Array<{
    id: string;
    group_folder: string;
    title: string;
    category: LifeThread['category'];
    status: LifeThread['status'];
    scope: LifeThread['scope'];
    related_subject_ids_json: string;
    context_tags_json: string;
    summary: string;
    next_action: string | null;
    next_followup_at: string | null;
    source_kind: LifeThread['sourceKind'];
    confidence_kind: LifeThread['confidenceKind'];
    user_confirmed: number;
    sensitivity: LifeThread['sensitivity'];
    surface_mode: LifeThread['surfaceMode'];
    followthrough_mode: LifeThread['followthroughMode'];
    last_surfaced_at: string | null;
    snoozed_until: string | null;
    linked_task_id: string | null;
    merged_into_thread_id: string | null;
    created_at: string;
    last_updated_at: string;
    last_used_at: string | null;
  }>;

  return rows.map(mapLifeThreadRow);
}

export function updateLifeThread(
  id: string,
  updates: Partial<
    Pick<
      LifeThread,
      | 'title'
      | 'category'
      | 'status'
      | 'scope'
      | 'relatedSubjectIds'
      | 'contextTags'
      | 'summary'
      | 'nextAction'
      | 'nextFollowupAt'
      | 'sourceKind'
      | 'confidenceKind'
      | 'userConfirmed'
      | 'sensitivity'
      | 'surfaceMode'
      | 'followthroughMode'
      | 'lastSurfacedAt'
      | 'snoozedUntil'
      | 'linkedTaskId'
      | 'mergedIntoThreadId'
      | 'lastUpdatedAt'
      | 'lastUsedAt'
    >
  >,
): boolean {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title);
  }
  if (updates.category !== undefined) {
    fields.push('category = ?');
    values.push(updates.category);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.scope !== undefined) {
    fields.push('scope = ?');
    values.push(updates.scope);
  }
  if (updates.relatedSubjectIds !== undefined) {
    fields.push('related_subject_ids_json = ?');
    values.push(JSON.stringify(updates.relatedSubjectIds));
  }
  if (updates.contextTags !== undefined) {
    fields.push('context_tags_json = ?');
    values.push(JSON.stringify(updates.contextTags));
  }
  if (updates.summary !== undefined) {
    fields.push('summary = ?');
    values.push(updates.summary);
  }
  if (updates.nextAction !== undefined) {
    fields.push('next_action = ?');
    values.push(updates.nextAction || null);
  }
  if (updates.nextFollowupAt !== undefined) {
    fields.push('next_followup_at = ?');
    values.push(updates.nextFollowupAt || null);
  }
  if (updates.sourceKind !== undefined) {
    fields.push('source_kind = ?');
    values.push(updates.sourceKind);
  }
  if (updates.confidenceKind !== undefined) {
    fields.push('confidence_kind = ?');
    values.push(updates.confidenceKind);
  }
  if (updates.userConfirmed !== undefined) {
    fields.push('user_confirmed = ?');
    values.push(updates.userConfirmed ? 1 : 0);
  }
  if (updates.sensitivity !== undefined) {
    fields.push('sensitivity = ?');
    values.push(updates.sensitivity);
  }
  if (updates.surfaceMode !== undefined) {
    fields.push('surface_mode = ?');
    values.push(updates.surfaceMode);
  }
  if (updates.followthroughMode !== undefined) {
    fields.push('followthrough_mode = ?');
    values.push(updates.followthroughMode);
  }
  if (updates.lastSurfacedAt !== undefined) {
    fields.push('last_surfaced_at = ?');
    values.push(updates.lastSurfacedAt || null);
  }
  if (updates.snoozedUntil !== undefined) {
    fields.push('snoozed_until = ?');
    values.push(updates.snoozedUntil || null);
  }
  if (updates.linkedTaskId !== undefined) {
    fields.push('linked_task_id = ?');
    values.push(updates.linkedTaskId || null);
  }
  if (updates.mergedIntoThreadId !== undefined) {
    fields.push('merged_into_thread_id = ?');
    values.push(updates.mergedIntoThreadId || null);
  }
  if (updates.lastUpdatedAt !== undefined) {
    fields.push('last_updated_at = ?');
    values.push(updates.lastUpdatedAt);
  }
  if (updates.lastUsedAt !== undefined) {
    fields.push('last_used_at = ?');
    values.push(updates.lastUsedAt || null);
  }
  if (fields.length === 0) return false;
  values.push(id);
  const result = db
    .prepare(`UPDATE life_threads SET ${fields.join(', ')} WHERE id = ?`)
    .run(...values);
  return result.changes === 1;
}

export function deleteLifeThread(id: string): boolean {
  db.prepare('DELETE FROM life_thread_signals WHERE thread_id = ?').run(id);
  const result = db.prepare('DELETE FROM life_threads WHERE id = ?').run(id);
  return result.changes === 1;
}

export function upsertLifeThreadSignal(record: LifeThreadSignal): void {
  assertValidGroupFolder(record.groupFolder);
  db.prepare(
    `
      INSERT INTO life_thread_signals (
        id,
        thread_id,
        group_folder,
        source_kind,
        summary_text,
        chat_jid,
        message_id,
        task_id,
        calendar_event_id,
        profile_fact_id,
        confidence_kind,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        thread_id = excluded.thread_id,
        group_folder = excluded.group_folder,
        source_kind = excluded.source_kind,
        summary_text = excluded.summary_text,
        chat_jid = excluded.chat_jid,
        message_id = excluded.message_id,
        task_id = excluded.task_id,
        calendar_event_id = excluded.calendar_event_id,
        profile_fact_id = excluded.profile_fact_id,
        confidence_kind = excluded.confidence_kind,
        created_at = excluded.created_at
    `,
  ).run(
    record.id,
    record.threadId,
    record.groupFolder,
    record.sourceKind,
    record.summaryText,
    record.chatJid || null,
    record.messageId || null,
    record.taskId || null,
    record.calendarEventId || null,
    record.profileFactId || null,
    record.confidenceKind,
    record.createdAt,
  );
}

export function listLifeThreadSignals(
  threadId: string,
  limit = 10,
): LifeThreadSignal[] {
  const rows = db
    .prepare(
      `
        SELECT *
        FROM life_thread_signals
        WHERE thread_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `,
    )
    .all(threadId, Math.max(1, limit)) as Array<{
    id: string;
    thread_id: string;
    group_folder: string;
    source_kind: LifeThreadSignal['sourceKind'];
    summary_text: string;
    chat_jid: string | null;
    message_id: string | null;
    task_id: string | null;
    calendar_event_id: string | null;
    profile_fact_id: string | null;
    confidence_kind: LifeThreadSignal['confidenceKind'];
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    threadId: row.thread_id,
    groupFolder: row.group_folder,
    sourceKind: row.source_kind,
    summaryText: row.summary_text,
    chatJid: row.chat_jid,
    messageId: row.message_id,
    taskId: row.task_id,
    calendarEventId: row.calendar_event_id,
    profileFactId: row.profile_fact_id,
    confidenceKind: row.confidence_kind,
    createdAt: row.created_at,
  }));
}

export function reassignLifeThreadSignals(
  fromThreadId: string,
  toThreadId: string,
): number {
  const result = db
    .prepare(
      `
        UPDATE life_thread_signals
        SET thread_id = ?
        WHERE thread_id = ?
      `,
    )
    .run(toThreadId, fromThreadId);
  return result.changes;
}

export interface CommunitySkillRecord {
  skill_id: string;
  owner: string;
  slug: string;
  display_name: string;
  source_url: string;
  canonical_clawhub_url: string | null;
  github_tree_url: string;
  cache_dir_name: string;
  cache_path: string;
  manifest_path: string;
  cached_at: string;
  file_count: number;
  virus_total_status: string | null;
  openclaw_status: string | null;
  openclaw_summary: string | null;
}

export interface EnabledCommunitySkillRecord extends CommunitySkillRecord {
  group_folder: string;
  enabled_at: string;
}

function mapCommunitySkillRow(
  row: CommunitySkillRecord | undefined,
): CommunitySkillRecord | undefined {
  return row;
}

export function upsertCommunitySkill(record: CommunitySkillRecord): void {
  db.prepare(
    `
      INSERT INTO community_skills (
        skill_id,
        owner,
        slug,
        display_name,
        source_url,
        canonical_clawhub_url,
        github_tree_url,
        cache_dir_name,
        cache_path,
        manifest_path,
        cached_at,
        file_count,
        virus_total_status,
        openclaw_status,
        openclaw_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(skill_id) DO UPDATE SET
        owner = excluded.owner,
        slug = excluded.slug,
        display_name = excluded.display_name,
        source_url = excluded.source_url,
        canonical_clawhub_url = excluded.canonical_clawhub_url,
        github_tree_url = excluded.github_tree_url,
        cache_dir_name = excluded.cache_dir_name,
        cache_path = excluded.cache_path,
        manifest_path = excluded.manifest_path,
        cached_at = excluded.cached_at,
        file_count = excluded.file_count,
        virus_total_status = excluded.virus_total_status,
        openclaw_status = excluded.openclaw_status,
        openclaw_summary = excluded.openclaw_summary
    `,
  ).run(
    record.skill_id,
    record.owner,
    record.slug,
    record.display_name,
    record.source_url,
    record.canonical_clawhub_url,
    record.github_tree_url,
    record.cache_dir_name,
    record.cache_path,
    record.manifest_path,
    record.cached_at,
    record.file_count,
    record.virus_total_status,
    record.openclaw_status,
    record.openclaw_summary,
  );
}

export function getCommunitySkillById(
  skillId: string,
): CommunitySkillRecord | undefined {
  return mapCommunitySkillRow(
    db
      .prepare('SELECT * FROM community_skills WHERE skill_id = ?')
      .get(skillId) as CommunitySkillRecord | undefined,
  );
}

export function getCommunitySkillByUrl(
  url: string,
): CommunitySkillRecord | undefined {
  return mapCommunitySkillRow(
    db
      .prepare(
        `
          SELECT *
          FROM community_skills
          WHERE source_url = ?
             OR canonical_clawhub_url = ?
             OR github_tree_url = ?
        `,
      )
      .get(url, url, url) as CommunitySkillRecord | undefined,
  );
}

export function getCommunitySkillByCacheDirName(
  cacheDirName: string,
): CommunitySkillRecord | undefined {
  return mapCommunitySkillRow(
    db
      .prepare('SELECT * FROM community_skills WHERE cache_dir_name = ?')
      .get(cacheDirName) as CommunitySkillRecord | undefined,
  );
}

export function enableCommunitySkillForGroup(
  groupFolder: string,
  skillId: string,
  enabledAt = new Date().toISOString(),
): void {
  assertValidGroupFolder(groupFolder);
  db.prepare(
    `
      INSERT INTO group_enabled_skills (group_folder, skill_id, enabled_at)
      VALUES (?, ?, ?)
      ON CONFLICT(group_folder, skill_id) DO UPDATE SET enabled_at = excluded.enabled_at
    `,
  ).run(groupFolder, skillId, enabledAt);
}

export function disableCommunitySkillForGroup(
  groupFolder: string,
  skillId: string,
): void {
  assertValidGroupFolder(groupFolder);
  db.prepare(
    'DELETE FROM group_enabled_skills WHERE group_folder = ? AND skill_id = ?',
  ).run(groupFolder, skillId);
}

export function listEnabledCommunitySkillsForGroup(
  groupFolder: string,
): EnabledCommunitySkillRecord[] {
  assertValidGroupFolder(groupFolder);
  return db
    .prepare(
      `
        SELECT c.*, g.group_folder, g.enabled_at
        FROM group_enabled_skills g
        INNER JOIN community_skills c ON c.skill_id = g.skill_id
        WHERE g.group_folder = ?
        ORDER BY c.display_name COLLATE NOCASE
      `,
    )
    .all(groupFolder) as EnabledCommunitySkillRecord[];
}

export function listAllEnabledCommunitySkills(): EnabledCommunitySkillRecord[] {
  return db
    .prepare(
      `
        SELECT c.*, g.group_folder, g.enabled_at
        FROM group_enabled_skills g
        INNER JOIN community_skills c ON c.skill_id = g.skill_id
        ORDER BY g.group_folder, c.display_name COLLATE NOCASE
      `,
    )
    .all() as EnabledCommunitySkillRecord[];
}

export interface CursorAgentRecord {
  id: string;
  group_folder: string;
  chat_jid: string;
  status: string;
  model: string | null;
  prompt_text: string;
  source_repository: string | null;
  source_ref: string | null;
  source_pr_url: string | null;
  target_url: string | null;
  target_pr_url: string | null;
  target_branch_name: string | null;
  auto_create_pr: number;
  open_as_cursor_github_app: number;
  skip_reviewer_request: number;
  summary: string | null;
  raw_json: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  last_synced_at: string | null;
}

export interface CursorAgentArtifactRecord {
  agent_id: string;
  absolute_path: string;
  size_bytes: number | null;
  updated_at: string | null;
  download_url: string | null;
  download_url_expires_at: string | null;
  synced_at: string;
}

export interface CursorAgentEventRecord {
  id: number;
  agent_id: string;
  event_type: string;
  status: string | null;
  summary: string | null;
  webhook_id: string | null;
  payload_json: string;
  received_at: string;
}

export interface PurchaseRequestRecord {
  id: string;
  group_folder: string;
  chat_jid: string;
  requested_by: string | null;
  provider: string;
  status: string;
  product_title: string;
  product_url: string | null;
  asin: string;
  offer_id: string;
  quantity: number;
  merchant_name: string | null;
  availability: string | null;
  buying_guidance: string | null;
  currency_code: string | null;
  expected_unit_price: number | null;
  expected_total_price: number | null;
  approval_code_hash: string;
  approval_expires_at: string;
  approved_by: string | null;
  approved_at: string | null;
  order_mode: string;
  external_order_id: string | null;
  submitted_order_id: string | null;
  submitted_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  failure_reason: string | null;
  raw_json: string | null;
  created_at: string;
  updated_at: string;
}

export function upsertCursorAgent(record: CursorAgentRecord): void {
  assertValidGroupFolder(record.group_folder);
  db.prepare(
    `
      INSERT INTO cursor_agents (
        id,
        group_folder,
        chat_jid,
        status,
        model,
        prompt_text,
        source_repository,
        source_ref,
        source_pr_url,
        target_url,
        target_pr_url,
        target_branch_name,
        auto_create_pr,
        open_as_cursor_github_app,
        skip_reviewer_request,
        summary,
        raw_json,
        created_by,
        created_at,
        updated_at,
        last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        group_folder = excluded.group_folder,
        chat_jid = excluded.chat_jid,
        status = excluded.status,
        model = excluded.model,
        prompt_text = excluded.prompt_text,
        source_repository = excluded.source_repository,
        source_ref = excluded.source_ref,
        source_pr_url = excluded.source_pr_url,
        target_url = excluded.target_url,
        target_pr_url = excluded.target_pr_url,
        target_branch_name = excluded.target_branch_name,
        auto_create_pr = excluded.auto_create_pr,
        open_as_cursor_github_app = excluded.open_as_cursor_github_app,
        skip_reviewer_request = excluded.skip_reviewer_request,
        summary = excluded.summary,
        raw_json = excluded.raw_json,
        created_by = excluded.created_by,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        last_synced_at = excluded.last_synced_at
    `,
  ).run(
    record.id,
    record.group_folder,
    record.chat_jid,
    record.status,
    record.model,
    record.prompt_text,
    record.source_repository,
    record.source_ref,
    record.source_pr_url,
    record.target_url,
    record.target_pr_url,
    record.target_branch_name,
    record.auto_create_pr,
    record.open_as_cursor_github_app,
    record.skip_reviewer_request,
    record.summary,
    record.raw_json,
    record.created_by,
    record.created_at,
    record.updated_at,
    record.last_synced_at,
  );
}

export function getCursorAgentById(id: string): CursorAgentRecord | undefined {
  return db.prepare('SELECT * FROM cursor_agents WHERE id = ?').get(id) as
    | CursorAgentRecord
    | undefined;
}

export function listCursorAgentsForGroup(
  groupFolder: string,
  limit = 50,
): CursorAgentRecord[] {
  assertValidGroupFolder(groupFolder);
  return db
    .prepare(
      `
        SELECT *
        FROM cursor_agents
        WHERE group_folder = ?
        ORDER BY created_at DESC
        LIMIT ?
      `,
    )
    .all(groupFolder, Math.max(1, limit)) as CursorAgentRecord[];
}

export function listCursorAgentsForChat(
  chatJid: string,
  limit = 50,
): CursorAgentRecord[] {
  return db
    .prepare(
      `
        SELECT *
        FROM cursor_agents
        WHERE chat_jid = ?
        ORDER BY created_at DESC
        LIMIT ?
      `,
    )
    .all(chatJid, Math.max(1, limit)) as CursorAgentRecord[];
}

export function listAllCursorAgents(limit = 200): CursorAgentRecord[] {
  return db
    .prepare(
      `
        SELECT *
        FROM cursor_agents
        ORDER BY created_at DESC
        LIMIT ?
      `,
    )
    .all(Math.max(1, limit)) as CursorAgentRecord[];
}

export function replaceCursorAgentArtifacts(
  agentId: string,
  artifacts: CursorAgentArtifactRecord[],
): void {
  const tx = db.transaction((records: CursorAgentArtifactRecord[]) => {
    db.prepare('DELETE FROM cursor_agent_artifacts WHERE agent_id = ?').run(
      agentId,
    );

    const insert = db.prepare(
      `
        INSERT INTO cursor_agent_artifacts (
          agent_id,
          absolute_path,
          size_bytes,
          updated_at,
          download_url,
          download_url_expires_at,
          synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    );

    for (const record of records) {
      insert.run(
        record.agent_id,
        record.absolute_path,
        record.size_bytes,
        record.updated_at,
        record.download_url,
        record.download_url_expires_at,
        record.synced_at,
      );
    }
  });

  tx(artifacts);
}

export function listCursorAgentArtifacts(
  agentId: string,
): CursorAgentArtifactRecord[] {
  return db
    .prepare(
      `
        SELECT *
        FROM cursor_agent_artifacts
        WHERE agent_id = ?
        ORDER BY updated_at DESC, absolute_path COLLATE NOCASE ASC
      `,
    )
    .all(agentId) as CursorAgentArtifactRecord[];
}

export function recordCursorAgentEvent(
  record: Omit<CursorAgentEventRecord, 'id'>,
): { inserted: boolean } {
  if (record.webhook_id) {
    const existing = db
      .prepare(
        'SELECT id FROM cursor_agent_events WHERE webhook_id = ? LIMIT 1',
      )
      .get(record.webhook_id) as { id: number } | undefined;
    if (existing) return { inserted: false };
  }

  db.prepare(
    `
      INSERT INTO cursor_agent_events (
        agent_id,
        event_type,
        status,
        summary,
        webhook_id,
        payload_json,
        received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    record.agent_id,
    record.event_type,
    record.status,
    record.summary,
    record.webhook_id,
    record.payload_json,
    record.received_at,
  );

  return { inserted: true };
}

export function listCursorAgentEvents(
  agentId: string,
  limit = 100,
): CursorAgentEventRecord[] {
  return db
    .prepare(
      `
        SELECT *
        FROM cursor_agent_events
        WHERE agent_id = ?
        ORDER BY received_at DESC
        LIMIT ?
      `,
    )
    .all(agentId, Math.max(1, limit)) as CursorAgentEventRecord[];
}

export function createPurchaseRequest(record: PurchaseRequestRecord): void {
  assertValidGroupFolder(record.group_folder);
  db.prepare(
    `
      INSERT INTO purchase_requests (
        id,
        group_folder,
        chat_jid,
        requested_by,
        provider,
        status,
        product_title,
        product_url,
        asin,
        offer_id,
        quantity,
        merchant_name,
        availability,
        buying_guidance,
        currency_code,
        expected_unit_price,
        expected_total_price,
        approval_code_hash,
        approval_expires_at,
        approved_by,
        approved_at,
        order_mode,
        external_order_id,
        submitted_order_id,
        submitted_at,
        completed_at,
        cancelled_at,
        failure_reason,
        raw_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    record.id,
    record.group_folder,
    record.chat_jid,
    record.requested_by,
    record.provider,
    record.status,
    record.product_title,
    record.product_url,
    record.asin,
    record.offer_id,
    record.quantity,
    record.merchant_name,
    record.availability,
    record.buying_guidance,
    record.currency_code,
    record.expected_unit_price,
    record.expected_total_price,
    record.approval_code_hash,
    record.approval_expires_at,
    record.approved_by,
    record.approved_at,
    record.order_mode,
    record.external_order_id,
    record.submitted_order_id,
    record.submitted_at,
    record.completed_at,
    record.cancelled_at,
    record.failure_reason,
    record.raw_json,
    record.created_at,
    record.updated_at,
  );
}

export function getPurchaseRequestById(
  id: string,
): PurchaseRequestRecord | undefined {
  return db.prepare('SELECT * FROM purchase_requests WHERE id = ?').get(id) as
    | PurchaseRequestRecord
    | undefined;
}

export function listPurchaseRequestsForGroup(
  groupFolder: string,
  limit = 50,
): PurchaseRequestRecord[] {
  assertValidGroupFolder(groupFolder);
  return db
    .prepare(
      `
        SELECT *
        FROM purchase_requests
        WHERE group_folder = ?
        ORDER BY created_at DESC
        LIMIT ?
      `,
    )
    .all(groupFolder, Math.max(1, limit)) as PurchaseRequestRecord[];
}

export function listPurchaseRequestsForChat(
  chatJid: string,
  limit = 50,
): PurchaseRequestRecord[] {
  return db
    .prepare(
      `
        SELECT *
        FROM purchase_requests
        WHERE chat_jid = ?
        ORDER BY created_at DESC
        LIMIT ?
      `,
    )
    .all(chatJid, Math.max(1, limit)) as PurchaseRequestRecord[];
}

export function listAllPurchaseRequests(limit = 200): PurchaseRequestRecord[] {
  return db
    .prepare(
      `
        SELECT *
        FROM purchase_requests
        ORDER BY created_at DESC
        LIMIT ?
      `,
    )
    .all(Math.max(1, limit)) as PurchaseRequestRecord[];
}

export function updatePurchaseRequest(
  id: string,
  updates: Partial<
    Pick<
      PurchaseRequestRecord,
      | 'status'
      | 'merchant_name'
      | 'availability'
      | 'buying_guidance'
      | 'currency_code'
      | 'expected_unit_price'
      | 'expected_total_price'
      | 'approved_by'
      | 'approved_at'
      | 'external_order_id'
      | 'submitted_order_id'
      | 'submitted_at'
      | 'completed_at'
      | 'cancelled_at'
      | 'failure_reason'
      | 'raw_json'
      | 'updated_at'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.merchant_name !== undefined) {
    fields.push('merchant_name = ?');
    values.push(updates.merchant_name);
  }
  if (updates.availability !== undefined) {
    fields.push('availability = ?');
    values.push(updates.availability);
  }
  if (updates.buying_guidance !== undefined) {
    fields.push('buying_guidance = ?');
    values.push(updates.buying_guidance);
  }
  if (updates.currency_code !== undefined) {
    fields.push('currency_code = ?');
    values.push(updates.currency_code);
  }
  if (updates.expected_unit_price !== undefined) {
    fields.push('expected_unit_price = ?');
    values.push(updates.expected_unit_price);
  }
  if (updates.expected_total_price !== undefined) {
    fields.push('expected_total_price = ?');
    values.push(updates.expected_total_price);
  }
  if (updates.approved_by !== undefined) {
    fields.push('approved_by = ?');
    values.push(updates.approved_by);
  }
  if (updates.approved_at !== undefined) {
    fields.push('approved_at = ?');
    values.push(updates.approved_at);
  }
  if (updates.external_order_id !== undefined) {
    fields.push('external_order_id = ?');
    values.push(updates.external_order_id);
  }
  if (updates.submitted_order_id !== undefined) {
    fields.push('submitted_order_id = ?');
    values.push(updates.submitted_order_id);
  }
  if (updates.submitted_at !== undefined) {
    fields.push('submitted_at = ?');
    values.push(updates.submitted_at);
  }
  if (updates.completed_at !== undefined) {
    fields.push('completed_at = ?');
    values.push(updates.completed_at);
  }
  if (updates.cancelled_at !== undefined) {
    fields.push('cancelled_at = ?');
    values.push(updates.cancelled_at);
  }
  if (updates.failure_reason !== undefined) {
    fields.push('failure_reason = ?');
    values.push(updates.failure_reason);
  }
  if (updates.raw_json !== undefined) {
    fields.push('raw_json = ?');
    values.push(updates.raw_json);
  }
  if (updates.updated_at !== undefined) {
    fields.push('updated_at = ?');
    values.push(updates.updated_at);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE purchase_requests SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export function getRegisteredMainChat():
  | (RegisteredGroup & { jid: string })
  | undefined {
  const row = db
    .prepare(
      `
        SELECT *
        FROM registered_groups
        WHERE is_main = 1 OR folder = 'main'
        ORDER BY is_main DESC, added_at ASC
        LIMIT 1
      `,
    )
    .get() as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered main chat with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
  );
}

export function deleteRegisteredGroup(jid: string): void {
  db.prepare('DELETE FROM registered_groups WHERE jid = ?').run(jid);
}

export function pruneChatBoundEphemeralContexts(chatJid: string): number {
  const suffixPattern = `%:${chatJid}`;
  const statements = [
    db.prepare('DELETE FROM cursor_operator_contexts WHERE chat_jid = ?'),
    db.prepare('DELETE FROM cursor_message_contexts WHERE chat_jid = ?'),
    db.prepare('DELETE FROM runtime_backend_card_contexts WHERE chat_jid = ?'),
    db.prepare('DELETE FROM runtime_backend_chat_selection WHERE chat_jid = ?'),
    db.prepare('DELETE FROM router_state WHERE key LIKE ?'),
  ];

  let changes = 0;
  changes += statements[0].run(chatJid).changes;
  changes += statements[1].run(chatJid).changes;
  changes += statements[2].run(chatJid).changes;
  changes += statements[3].run(chatJid).changes;
  changes += statements[4].run(suffixPattern).changes;

  return changes;
}

export function repairRegisteredMainChat(params: {
  fromJid: string;
  toJid: string;
  toName: string;
}): RegisteredGroup & { jid: string } {
  const tx = db.transaction(
    (input: { fromJid: string; toJid: string; toName: string }) => {
      const existing = getRegisteredGroup(input.fromJid);
      if (!existing) {
        throw new Error(
          `Cannot repair main chat registration because ${input.fromJid} is not registered.`,
        );
      }
      if (existing.isMain !== true && existing.folder !== 'main') {
        throw new Error(
          `Cannot repair non-main registration ${input.fromJid} as the main chat.`,
        );
      }

      const conflictingTarget = getRegisteredGroup(input.toJid);
      if (
        conflictingTarget &&
        conflictingTarget.jid !== input.fromJid &&
        conflictingTarget.folder !== existing.folder
      ) {
        throw new Error(
          `Cannot repair main chat registration because ${input.toJid} is already registered to folder "${conflictingTarget.folder}".`,
        );
      }

      if (input.fromJid !== input.toJid) {
        pruneChatBoundEphemeralContexts(input.fromJid);
      }

      if (conflictingTarget && conflictingTarget.jid !== input.fromJid) {
        deleteRegisteredGroup(conflictingTarget.jid);
      }

      db.prepare(
        `
        UPDATE registered_groups
        SET jid = ?, name = ?, folder = ?, trigger_pattern = ?, added_at = ?,
            container_config = ?, requires_trigger = ?, is_main = ?
        WHERE jid = ?
      `,
      ).run(
        input.toJid,
        input.toName,
        existing.folder,
        existing.trigger,
        existing.added_at,
        existing.containerConfig
          ? JSON.stringify(existing.containerConfig)
          : null,
        existing.requiresTrigger === undefined
          ? 1
          : existing.requiresTrigger
            ? 1
            : 0,
        existing.isMain ? 1 : 0,
        input.fromJid,
      );

      const repaired = getRegisteredGroup(input.toJid);
      if (!repaired) {
        throw new Error(
          `Main chat repair failed to load the updated registration for ${input.toJid}.`,
        );
      }
      return repaired;
    },
  );

  return tx(params);
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
    };
  }
  return result;
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
