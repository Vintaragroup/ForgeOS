import { updateLineItem, deleteLineItem } from "@/lib/estimate-service";

const OPPORTUNITY_ID = "cmtuquspx000104lbkwgkcqq8";
const ACTOR_ID = "cmsvby4h900005by34a0x0mve"; // ioncreative01@gmail.com

const RECATEGORIZE = {
  id: "cmtutqkad000k09gm47y38zbh",
  description: "Shoe display structure fabrication...",
  from: "Graphics",
  to: "Custom Build",
};

const DUPLICATES_TO_DELETE = [
  { id: "cmtuu6b4f000904jw8xz7c7rq", description: "12 X 39 hole door frame w/ D.S. black slat" },
  { id: "cmtuu6b2v000604jwc1db7nr9", description: "16 X 39 hole frames w/ D.S. black slat" },
  { id: "cmtuu6b30000704jwd893lmj9", description: "8 x 39 hole frames" },
];

const DRY_RUN = process.argv.includes("--apply") === false;

async function main() {
  console.log(DRY_RUN ? "=== DRY RUN (pass --apply to execute) ===" : "=== APPLYING ===");

  console.log(`\nRecategorize: "${RECATEGORIZE.description}" ${RECATEGORIZE.from} -> ${RECATEGORIZE.to}`);
  if (!DRY_RUN) {
    await updateLineItem(OPPORTUNITY_ID, RECATEGORIZE.id, { category: RECATEGORIZE.to }, ACTOR_ID);
    console.log("  done");
  }

  for (const dup of DUPLICATES_TO_DELETE) {
    console.log(`\nDelete duplicate: "${dup.description}" (${dup.id})`);
    if (!DRY_RUN) {
      await deleteLineItem(OPPORTUNITY_ID, dup.id, ACTOR_ID);
      console.log("  done");
    }
  }

  console.log(DRY_RUN ? "\n=== DRY RUN COMPLETE, no changes made ===" : "\n=== APPLIED ===");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => process.exit(0));
