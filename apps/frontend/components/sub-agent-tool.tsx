"use client";

import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  BotIcon,
  XCircleIcon,
} from "lucide-react";
import type { ToolUIPart } from "ai";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "./ai-elements/message";
import { Shimmer } from "./ai-elements/shimmer";
import type { ReactNode } from "react";

const getStatusBadge = (status: ToolUIPart["state"]) => {
  const labels: Record<ToolUIPart["state"], string> = {
    "input-streaming": "Pending",
    "input-available": "Running",
    "output-available": "Completed",
    "output-error": "Error",
    "approval-requested": "Approval Requested",
    "approval-responded": "Approval Responded",
    "output-denied": "Denied",
  };

  const icons: Record<ToolUIPart["state"], ReactNode> = {
    "input-streaming": <CircleIcon className="size-4" />,
    "input-available": <ClockIcon className="size-4 animate-pulse" />,
    "output-available": <CheckCircleIcon className="size-4 text-green-600" />,
    "output-error": <XCircleIcon className="size-4 text-red-600" />,
    "approval-requested": <ClockIcon className="size-4" />,
    "approval-responded": <CheckCircleIcon className="size-4" />,
    "output-denied": <XCircleIcon className="size-4 text-red-600" />,
  };

  return (
    <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
      {icons[status]}
      {labels[status]}
    </Badge>
  );
};

/**
 * Extracts the sub-agent name from the tool name.
 * e.g., "delegateToDadJokeBot" -> "Dad Joke Bot"
 */
const extractSubAgentName = (toolName: string): string => {
  const prefix = "delegateTo";
  if (toolName.startsWith(prefix)) {
    const namePart = toolName.slice(prefix.length);
    return namePart.replace(/([A-Z])/g, " $1").trim();
  }
  return toolName;
};

interface SubAgentToolProps {
  toolPart: ToolUIPart;
}

/**
 * Renders a sub-agent tool invocation. Shows a working indicator while the
 * sub-agent runs, then the plain-text result when complete.
 */
export const SubAgentTool = ({ toolPart }: SubAgentToolProps) => {
  const input = toolPart.input as { task?: string };
  const output = toolPart.output as string | null;
  const errorText = toolPart.errorText;
  const subAgentName = extractSubAgentName(toolPart.type.replace("tool-", ""));
  const isRunning =
    toolPart.state === "input-streaming" ||
    toolPart.state === "input-available";

  return (
    <Collapsible className="not-prose mb-4 w-full rounded-md border group/subagent">
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-4 p-3">
        <div className="flex items-center gap-2">
          <BotIcon className="size-4 text-muted-foreground" />
          <span className="font-medium text-sm">{subAgentName}</span>
          {getStatusBadge(errorText ? "output-error" : toolPart.state)}
        </div>
        <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]/subagent:rotate-180" />
      </CollapsibleTrigger>

      <CollapsibleContent
        className={cn(
          "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
        )}
      >
        {/* Task input */}
        <div className="space-y-2 border-t p-4">
          <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Task
          </h4>
          <div className="rounded-md bg-muted/50 p-3 text-sm">
            {input?.task || "No task description"}
          </div>
        </div>

        {/* Working indicator, error, or response */}
        {errorText ? (
          <div className="space-y-2 border-t p-4">
            <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
              Error
            </h4>
            <div className="rounded-md bg-destructive/10 p-3 text-destructive text-sm">
              {errorText}
            </div>
          </div>
        ) : isRunning ? (
          <div className="border-t p-4">
            <Shimmer className="text-sm">Working...</Shimmer>
          </div>
        ) : output ? (
          <div className="space-y-2 border-t p-4">
            <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
              Response
            </h4>
            <Message from="assistant">
              <MessageContent className="max-w-full">
                <MessageResponse>{output}</MessageResponse>
              </MessageContent>
            </Message>
          </div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
};
