"use client";

import { useState, type MouseEvent } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Alert, AlertTitle, AlertDescription } from "./ui/alert";
import { TriangleAlert, Copy, Check } from "lucide-react";
import { useTimeout } from "@/hooks/use-timeout";
import { copyToClipboard } from "@/lib/clipboard";
import { toast } from "sonner";

interface ChatErrorDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  error: Error | undefined;
}

export const ChatErrorDialog = ({
  isOpen,
  onOpenChange,
  error,
}: ChatErrorDialogProps) => {
  const [copied, setCopied] = useState(false);
  const scheduleCopiedReset = useTimeout();
  const message = error?.message || "An unknown error occurred.";

  const handleCopy = async (event: MouseEvent<HTMLButtonElement>) => {
    // Inside the dialog, so its focus trap leaves the fallback alone.
    const container = event.currentTarget.parentElement ?? undefined;
    if (!(await copyToClipboard(message, container))) {
      toast.error("Failed to copy to clipboard");
      return;
    }
    setCopied(true);
    scheduleCopiedReset(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Chat Error</DialogTitle>
          <DialogDescription>
            An error occurred while processing your request.
          </DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>Error details</AlertTitle>
            <AlertDescription className="break-all">{message}</AlertDescription>
          </Alert>
        </div>
        <DialogFooter className="flex-row justify-end">
          <Button
            variant="outline"
            size="icon"
            aria-label="Copy error details"
            onClick={handleCopy}
          >
            {copied ? <Check /> : <Copy />}
          </Button>
          <Button onClick={() => onOpenChange(false)}>Ok</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
