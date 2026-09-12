// Sales-to-production handoff, Piece 4: a real downloadable PDF scoped to
// ONE production Task -- the department/vendor deliverable
// generateTasksFromEstimate's grouping (task-generation-service.ts) makes
// possible. Same @react-pdf/renderer pattern cut-list-labels-pdf.tsx
// already established (a pure, testable data-builder + a presentational
// Document component, rendered via renderToBuffer in a GET route).
//
// A THIRD trust tier, distinct from the other two PDFs in this app: the
// Proposal PDF (proposal-pdf.tsx) is client-facing sell price, and the
// cut-list export is fully internal -- this one may go to an outside
// vendor with no ForgeOS login, who must never see Expo's own internal
// cost basis. TaskPacketLineItem's own type has no unitCost/totalCost
// field at all, so this is enforced structurally: there is no cost data
// for this component to accidentally render, not just a rule this file
// has to remember to follow.
import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import { BRAND } from "@/lib/brand";

export interface TaskPacketLineItem {
  description: string;
  qty: number;
  unit: string | null;
  category: string | null;
}

export interface TaskPacketData {
  showName: string;
  companyName: string;
  jobNumber: string | null;
  taskDescription: string;
  // Pre-resolved into one human string at build time (see
  // buildTaskPacketData) -- "Graphics Department", "Vendor: Acme Signs",
  // or the honest "Unassigned" case -- so this component never has to
  // know about departmentCode/vendorId/LaborRate lookups itself.
  departmentOrVendor: string;
  dueDate: string | null;
  lineItems: TaskPacketLineItem[];
}

// Pure, testable independent of rendering -- same split cut-list-labels-
// pdf.tsx's own buildCutListLabels makes. Accepts plain, explicit
// arguments rather than a raw Prisma payload so a caller (the route) does
// its own DB shaping and this stays trivial to unit test.
export function buildTaskPacketData(input: {
  showName: string;
  companyName: string;
  jobNumber: string | null;
  taskDescription: string;
  departmentCode: string | null;
  departmentName: string | null;
  vendorName: string | null;
  dueDate: Date | null;
  lineItems: TaskPacketLineItem[];
}): TaskPacketData {
  const departmentOrVendor = input.vendorName
    ? `Vendor: ${input.vendorName}`
    : input.departmentCode
      ? `${input.departmentName ?? input.departmentCode} Department`
      : "Unassigned -- needs department/vendor review";

  return {
    showName: input.showName,
    companyName: input.companyName,
    jobNumber: input.jobNumber,
    taskDescription: input.taskDescription,
    departmentOrVendor,
    dueDate: input.dueDate ? input.dueDate.toISOString().slice(0, 10) : null,
    lineItems: input.lineItems,
  };
}

const styles = StyleSheet.create({
  page: { padding: 36, fontFamily: "Helvetica", color: BRAND.black, fontSize: 10 },
  header: { marginBottom: 16, borderBottomWidth: 1, borderBottomColor: "#d4d4d4", paddingBottom: 8 },
  showName: { fontSize: 14, fontWeight: 700, color: BRAND.navy },
  meta: { fontSize: 9, color: "#737373", marginTop: 2 },
  taskTitle: { fontSize: 12, fontWeight: 700, marginTop: 12, marginBottom: 4 },
  taskMeta: { fontSize: 9, color: "#737373", marginBottom: 12 },
  tableHeaderRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: BRAND.black,
    paddingBottom: 4,
    marginBottom: 4,
  },
  tableRow: { flexDirection: "row", paddingVertical: 3, borderBottomWidth: 0.5, borderBottomColor: "#e5e5e5" },
  colDescription: { flex: 1 },
  colQty: { width: 60, textAlign: "right" },
  colUnit: { width: 50, textAlign: "right" },
  colCategory: { width: 110, textAlign: "right" },
  headerCell: { fontSize: 8, textTransform: "uppercase", color: "#737373", letterSpacing: 0.5 },
  empty: { fontSize: 9, color: "#737373", marginTop: 8 },
});

export function TaskPacketPdfDocument({ data }: { data: TaskPacketData }) {
  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.showName}>{data.showName}</Text>
          <Text style={styles.meta}>
            {data.companyName}
            {data.jobNumber ? ` -- Job ${data.jobNumber}` : ""}
          </Text>
        </View>
        <Text style={styles.taskTitle}>{data.taskDescription}</Text>
        <Text style={styles.taskMeta}>
          {data.departmentOrVendor}
          {data.dueDate ? ` · Due ${data.dueDate}` : ""}
        </Text>
        {data.lineItems.length === 0 ? (
          <Text style={styles.empty}>No line items assigned to this task yet.</Text>
        ) : (
          <View>
            <View style={styles.tableHeaderRow}>
              <Text style={[styles.headerCell, styles.colDescription]}>Description</Text>
              <Text style={[styles.headerCell, styles.colQty]}>Qty</Text>
              <Text style={[styles.headerCell, styles.colUnit]}>Unit</Text>
              <Text style={[styles.headerCell, styles.colCategory]}>Category</Text>
            </View>
            {data.lineItems.map((li, i) => (
              <View key={i} style={styles.tableRow}>
                <Text style={styles.colDescription}>{li.description}</Text>
                <Text style={styles.colQty}>{li.qty}</Text>
                <Text style={styles.colUnit}>{li.unit ?? ""}</Text>
                <Text style={styles.colCategory}>{li.category ?? ""}</Text>
              </View>
            ))}
          </View>
        )}
      </Page>
    </Document>
  );
}
