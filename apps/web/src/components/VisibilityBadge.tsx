import { Badge } from "@imagine/components/components/Badge";
import { FeatherGlobe, FeatherLock } from "@subframe/core";

export function VisibilityBadge({ visibility }: { visibility: "private" | "public" }) {
  return visibility === "public" ? (
    <Badge variant="success" icon={<FeatherGlobe />}>
      Public
    </Badge>
  ) : (
    <Badge variant="neutral" icon={<FeatherLock />}>
      Private
    </Badge>
  );
}
