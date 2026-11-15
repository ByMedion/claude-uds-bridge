import { Database } from 'bun:sqlite';
import { DialogueBudget } from '../src/dialogue';

const db = new Database(process.argv[2]!);
db.exec('PRAGMA busy_timeout=5000;');
const budget = new DialogueBudget(db);
let admitted = 0;
for (let i = 0; i < 50; i++) if (budget.reserve(`${process.argv[3]}-${i}`)) admitted++;
console.log(admitted);
db.close();
