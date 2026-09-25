// Measures how @react-pdf/renderer actually decides page breaks.
//
// Written because reasoning about it was wrong twice: minPresenceAhead on
// a wrap={false} node did nothing, and moving it to the container
// reserved far more than predicted. This renders blocks of KNOWN height
// against a KNOWN amount of remaining space and reads the answer out of
// the resulting PDF, so proposal-pdf.tsx's constants can be chosen from
// evidence instead of hoped at.
//
// Run: npx tsx scripts/pdf-break-harness.tsx
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import { extractText, getDocumentProxy } from "unpdf";

// proposal-pdf.tsx's own page geometry, so the numbers transfer.
const CONTENT_HEIGHT = 792 - 84 - 60; // 648pt

const s = StyleSheet.create({
  page: { paddingTop: 84, paddingBottom: 60, paddingHorizontal: 48, fontSize: 10, fontFamily: "Helvetica" },
  filler: { backgroundColor: "#eee" },
  header: { height: 20, backgroundColor: "#ccc" },
  row: { height: 14 },
});

type Config = "plain" | "atomicHeader" | "mpaOnAtomic" | "mpaOnContainer" | "wrapFalseWhole" | "headerPlusTwo" | "mpaWrapperRoundAtomicHeader";

const BODY_ROWS = 3;
const HEADER_H = 20;
const BLOCK_H = HEADER_H + BODY_ROWS * 14; // 62pt

function Probe({ config, mpa }: { config: Config; mpa: number }) {
  const header = <View style={s.header}><Text>PROBEHEAD</Text></View>;
  const body = (
    <>
      {Array.from({ length: BODY_ROWS }, (_, i) => (
        <View key={i} style={s.row}><Text>{`PROBEBODY${i}`}</Text></View>
      ))}
    </>
  );

  if (config === "plain") return <View>{header}{body}</View>;
  if (config === "atomicHeader") return <View><View wrap={false}>{header}</View>{body}</View>;
  if (config === "mpaOnAtomic") return <View><View wrap={false} minPresenceAhead={mpa}>{header}</View>{body}</View>;
  if (config === "mpaOnContainer") return <View minPresenceAhead={mpa}><View wrap={false}>{header}</View>{body}</View>;
  // The candidate: the heading travels with its first two rows as one
  // atomic unit, and everything after it flows.
  if (config === "headerPlusTwo") {
    return (
      <View>
        <View wrap={false}>
          {header}
          <View style={s.row}><Text>PROBEBODY0</Text></View>
          <View style={s.row}><Text>PROBEBODY1</Text></View>
        </View>
        <View style={s.row}><Text>{`PROBEBODY${BODY_ROWS - 1}`}</Text></View>
      </View>
    );
  }
  // The candidate for a heading with no content of its own to carry: a
  // WRAPPABLE wrapper holding only the atomic header, so minPresenceAhead
  // applies (it is ignored on a wrap={false} node) and moves just the
  // heading rather than the whole section.
  if (config === "mpaWrapperRoundAtomicHeader") {
    return (
      <View>
        <View minPresenceAhead={mpa}>
          <View wrap={false}>{header}</View>
        </View>
        {body}
      </View>
    );
  }
  return <View wrap={false}>{header}{body}</View>;
}

async function pageOf(config: Config, fillerHeight: number, mpa: number) {
  const buffer = await renderToBuffer(
    <Document>
      <Page size="LETTER" style={s.page}>
        <View style={[s.filler, { height: fillerHeight }]}><Text>FILLER</Text></View>
        <Probe config={config} mpa={mpa} />
      </Page>
    </Document>,
  );
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = text as string[];
  const find = (needle: string) => pages.findIndex((p) => p.includes(needle)) + 1;
  return { head: find("PROBEHEAD"), lastBody: find(`PROBEBODY${BODY_ROWS - 1}`), pages: pages.length };
}

async function main() {
  const mpa = 72;
  console.log(`content height ${CONTENT_HEIGHT}pt · probe block ${BLOCK_H}pt (header ${HEADER_H} + ${BODY_ROWS} rows)`);
  console.log(`minPresenceAhead tested at ${mpa}\n`);
  console.log("config            remaining  headerPage  lastBodyPage  verdict");

  const configs: Config[] = ["plain", "mpaWrapperRoundAtomicHeader"];
  for (const config of configs) {
    for (const remaining of [120, 80, 62, 48, 40, 24]) {
      const filler = CONTENT_HEIGHT - remaining;
      const { head, lastBody } = await pageOf(config, filler, mpa);
      const verdict =
        head === 0 ? "?" : head !== lastBody ? "SPLIT" : head === 1 ? "fits page 1" : "moved whole";
      console.log(
        `${config.padEnd(17)} ${String(remaining).padStart(6)}pt ${String(head).padStart(10)} ${String(lastBody).padStart(13)}  ${verdict}`,
      );
    }
    console.log("");
  }
}
main();
