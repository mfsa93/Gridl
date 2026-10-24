import { TriangleAlert } from "lucide-react";
import { formatNumber, t } from "../lib/i18n";
import type { PlanNode } from "./plan";

/** A query plan as an indented tree, with full scans of large tables marked. */
export function PlanView({ nodes }: { nodes: PlanNode[] }) {
  const scans = count(nodes);
  return (
    <div className="plan-view">
      <div className="plan-head">
        <span>{t("app.plan.step")}</span>
        <span>{t("app.plan.rows")}</span>
        <span>{t("app.plan.cost")}</span>
      </div>
      {scans > 0 ? (
        <div className="plan-warning">
          <TriangleAlert size={14} /> {t("app.plan.fullScans", { count: scans })}
        </div>
      ) : null}
      <div className="plan-body">
        {nodes.map((node, index) => (
          <Step key={index} node={node} depth={0} />
        ))}
      </div>
    </div>
  );
}

function count(nodes: PlanNode[]): number {
  return nodes.reduce((total, node) => total + (node.fullScan ? 1 : 0) + count(node.children), 0);
}

function Step({ node, depth }: { node: PlanNode; depth: number }) {
  return (
    <>
      <div className={node.fullScan ? "plan-row full-scan" : "plan-row"} title={node.fullScan ? t("app.plan.fullScanTitle") : undefined}>
        <span className="plan-step" style={{ paddingLeft: depth * 16 }}>
          {depth > 0 ? <span className="plan-branch">└</span> : null}
          {node.fullScan ? <TriangleAlert size={13} /> : null}
          <strong>{node.label}</strong>
          {node.detail ? <small>{node.detail}</small> : null}
        </span>
        <span>{node.rows === null ? "" : formatNumber(node.rows)}</span>
        <span>{node.cost === null ? "" : formatNumber(Math.round(node.cost * 100) / 100)}</span>
      </div>
      {node.children.map((child, index) => (
        <Step key={index} node={child} depth={depth + 1} />
      ))}
    </>
  );
}
