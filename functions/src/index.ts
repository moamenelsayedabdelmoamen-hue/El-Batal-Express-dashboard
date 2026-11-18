import { setGlobalOptions } from "firebase-functions";
import { menuSuggestion } from "./genkit-sample";

setGlobalOptions({ maxInstances: 10 });

export { menuSuggestion };
