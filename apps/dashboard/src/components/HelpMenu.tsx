"use client";

/**
 * The ⋮ help menu — support / report issue / feedback / docs / community.
 *
 * One definition, so every page header offers the same set of links in the same
 * order (it was previously inline in the project-detail page only). Drop it next
 * to a page's primary action.
 */

import { Bug, BookOpen, ExternalLink, HelpCircle, MessageSquare, MoreVertical } from "lucide-react";
import DropdownMenu, { type MenuAction } from "@/components/ui/DropdownMenu";
import { useI18n } from "@/components/i18n-provider";

const SUPPORT_URL = "https://openship.io/support";
const ISSUE_URL = "https://github.com/oblien/openship/issues/new";
const FEEDBACK_URL = "https://openship.io/contact";
const DOCS_URL = "https://openship.io/docs";
const COMMUNITY_URL = "https://discord.gg/Q9eWNCeXjg";

const open = (url: string) => window.open(url, "_blank", "noopener,noreferrer");

/** The actions themselves — exported so a page can append its own items. */
export function useHelpMenuActions(): MenuAction[] {
  const { t } = useI18n();
  return [
    {
      id: "support",
      label: t.projects.help.contactSupport,
      icon: <HelpCircle className="size-4" />,
      onClick: () => open(SUPPORT_URL),
    },
    {
      id: "report-issue",
      label: t.projects.help.reportIssue,
      icon: <Bug className="size-4" />,
      onClick: () => open(ISSUE_URL),
    },
    {
      id: "feedback",
      label: t.projects.help.sendFeedback,
      icon: <MessageSquare className="size-4" />,
      onClick: () => open(FEEDBACK_URL),
    },
    { id: "divider", divider: true },
    {
      id: "documentation",
      label: t.projects.help.documentation,
      icon: <BookOpen className="size-4" />,
      onClick: () => open(DOCS_URL),
    },
    {
      id: "community",
      label: t.projects.help.joinCommunity,
      icon: <ExternalLink className="size-4" />,
      onClick: () => open(COMMUNITY_URL),
    },
  ];
}

export function HelpMenu({
  /** Extra page-specific items, prepended above the standard help links. */
  extraActions,
  className,
}: {
  extraActions?: MenuAction[];
  className?: string;
}) {
  const help = useHelpMenuActions();
  const actions = extraActions?.length
    ? [...extraActions, { id: "extra-divider", divider: true }, ...help]
    : help;
  return (
    <DropdownMenu
      actions={actions}
      align="right"
      className={className}
      trigger={<MoreVertical className="size-5 text-muted-foreground" />}
    />
  );
}
