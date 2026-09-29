"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { formatDateTime } from "@/lib/format-date";

/** The fire endpoint an external caller POSTs to (ADR-0030). */
export const inboundEndpointUrl = (backendUrl: string, triggerId: string) =>
  `${backendUrl.replace(/\/+$/, "")}/hooks/triggers/${triggerId}`;

const CopyRow = ({
  id,
  label,
  value,
  copiedMessage,
}: {
  id: string;
  label: string;
  value: string;
  copiedMessage: string;
}) => (
  <Field>
    <FieldLabel htmlFor={id}>{label}</FieldLabel>
    <div className="flex items-center gap-2">
      <Input id={id} value={value} readOnly className="font-mono text-xs" />
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="shrink-0 cursor-pointer"
        aria-label={`Copy ${label.toLowerCase()}`}
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          toast.success(copiedMessage);
        }}
      >
        <Copy className="h-4 w-4" />
      </Button>
    </div>
  </Field>
);

/**
 * Shows an Inbound Trigger's token the one time it is readable — on creation
 * and on regenerate. Only its hash is stored, so once this closes the token
 * cannot be shown again; a lost one is replaced by regenerating.
 */
export const InboundTokenDialog = ({
  open,
  token,
  endpointUrl,
  expiresAt,
  onClose,
}: {
  open: boolean;
  token: string;
  endpointUrl: string;
  expiresAt?: string | Date | null;
  onClose: () => void;
}) => (
  <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
    <DialogContent
      // Closing is the one irreversible step, so a stray click outside must
      // not do it: only the button does.
      onPointerDownOutside={(e) => e.preventDefault()}
    >
      <DialogHeader>
        <DialogTitle>Copy the token now</DialogTitle>
        <DialogDescription>
          The system that calls this trigger sends this token as{" "}
          <code>Authorization: Bearer &lt;token&gt;</code>.
        </DialogDescription>
      </DialogHeader>

      <Alert>
        <AlertDescription>
          This is the only time the token is shown. If you lose it, regenerate
          it on the trigger&apos;s page. That stops the old one working.
        </AlertDescription>
      </Alert>

      <CopyRow
        id="inbound-token"
        label="Token"
        value={token}
        copiedMessage="Token copied to clipboard"
      />
      <CopyRow
        id="inbound-endpoint"
        label="Endpoint"
        value={endpointUrl}
        copiedMessage="Endpoint copied to clipboard"
      />
      {expiresAt && (
        <p className="text-sm text-muted-foreground">
          Expires {formatDateTime(expiresAt)}.
        </p>
      )}

      <DialogFooter>
        <Button type="button" className="cursor-pointer" onClick={onClose}>
          I&apos;ve copied it
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);
