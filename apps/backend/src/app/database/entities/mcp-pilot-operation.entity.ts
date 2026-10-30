import {
  Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn
} from 'typeorm';
import Workspace from './workspace.entity';
import User from './user.entity';

export type McpPilotKind = 'testcenter-import' | 'autocoding';
export type McpPilotStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'needs_attention';
export type McpPilotImportPayload = {
  server_id: string;
  source_url: string;
  tc_workspace_id: number;
  groups: string[];
  options: Record<string, boolean>;
  response_overwrite_mode: 'skip';
};
export type McpPilotCodingPayload = { auto_coder_run: 1; groups?: string[] };
export type McpPilotStatistics = {
  persons?: number; booklets?: number; units?: number; test_files?: number;
  import_tasks?: number; warning_count?: number; error_count?: number;
  totalResponses?: number; statusCounts?: Record<string, number>; result_version?: 'v1';
};

@Entity('mcp_pilot_operation')
@Index('mcp_pilot_request_unique', ['workspace_id', 'actor_id', 'kind', 'request_key'], { unique: true })
export class McpPilotOperation {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'int' })
  workspace_id!: number;

  @Column({ type: 'int' })
  actor_id!: number;

  @Column({ type: 'varchar', length: 32 })
  kind!: McpPilotKind;

  @Column({ type: 'varchar', length: 120 })
  request_key!: string;

  @Column({ type: 'varchar', length: 64 })
  request_hash!: string;

  @Column({ type: 'jsonb' })
  payload!: McpPilotImportPayload | McpPilotCodingPayload;

  @Column({ type: 'varchar', length: 24, default: 'queued' })
  status!: McpPilotStatus;

  @Column({ type: 'text', nullable: true, select: false })
  credential!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  credential_expires_at!: Date | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  external_job_id!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  statistics!: McpPilotStatistics | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  error_code!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @ManyToOne(() => Workspace, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'workspace_id' })
  workspace!: Workspace;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'actor_id' })
  actor!: User;
}
