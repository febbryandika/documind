"use client";

import { FileTextIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { Source } from "@/lib/chat";

/**
 * The citations for one answer. The chip is numbered to match the [1], [2]
 * markers in the text above it — that pairing is the whole point of the
 * feature (SPEC §1): a supervisor reads a claim, opens the chip, and checks the
 * quoted passage against the page number in the printed binder.
 *
 * The API guarantees the order, building the markers and this array in one pass.
 */
export function SourceChips({ sources }: { sources: Source[] }) {
  if (sources.length === 0) return null;

  return (
    <ul className="flex flex-wrap gap-1.5">
      {sources.map((source, index) => (
        <li key={source.chunkId}>
          <Popover>
            <PopoverTrigger asChild>
              <Badge asChild variant="outline">
                {/* A real button: these open a popover, so they must be
                    focusable and reachable from the keyboard. */}
                <button type="button" className="cursor-pointer">
                  <FileTextIcon aria-hidden />
                  {`[${index + 1}] Page ${source.pageNumber}`}
                </button>
              </Badge>
            </PopoverTrigger>
            <PopoverContent>
              <PopoverTitle>{`Source [${index + 1}] · page ${source.pageNumber}`}</PopoverTitle>
              <PopoverDescription>{source.excerpt}</PopoverDescription>
            </PopoverContent>
          </Popover>
        </li>
      ))}
    </ul>
  );
}
