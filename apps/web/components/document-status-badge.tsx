import { CheckIcon, LoaderIcon, TriangleAlertIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { STATUS_LABELS, type Status } from "@/lib/documents";

// The theme is entirely achromatic apart from --destructive, so colour alone
// cannot carry the distinction between processing and ready. Each status gets
// an icon too, which also covers colour-blind and greyscale-print readers.
const STATUS_STYLES = {
  processing: { variant: "secondary", Icon: LoaderIcon, spin: true },
  ready: { variant: "default", Icon: CheckIcon, spin: false },
  failed: { variant: "destructive", Icon: TriangleAlertIcon, spin: false },
} as const;

export function DocumentStatusBadge({ status }: { status: Status }) {
  const { variant, Icon, spin } = STATUS_STYLES[status];

  return (
    <Badge variant={variant}>
      <Icon aria-hidden className={spin ? "animate-spin" : undefined} />
      {STATUS_LABELS[status]}
    </Badge>
  );
}
