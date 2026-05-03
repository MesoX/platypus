CREATE TABLE "dashboard" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"desktop_layout" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mobile_layout" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "widget" (
	"id" text PRIMARY KEY NOT NULL,
	"dashboard_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dashboard" ADD CONSTRAINT "dashboard_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget" ADD CONSTRAINT "widget_dashboard_id_dashboard_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."dashboard"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_dashboard_workspace_id" ON "dashboard" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_dashboard_workspace_name" ON "dashboard" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "idx_widget_dashboard_id" ON "widget" USING btree ("dashboard_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_widget_dashboard_title" ON "widget" USING btree ("dashboard_id","title");