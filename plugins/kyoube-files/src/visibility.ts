import { isRestricted, projectVisible, type PolicyReader } from "@kyoube/visibility";

/**
 * Whether a person may see a project's folder under the company's need-to-know policy. An
 * open company, an owner, an admin and a person in a sees-all group see every project; anyone
 * else sees the projects their groups list. When the policy cannot be read, a restricted
 * person sees nothing (owners and admins are never locked out by a broken policy).
 * `role` is the person's lower-cased company role, `null` when they have none.
 */
export async function projectVisibleFor(reader: PolicyReader, companyId: string, person: { userId: string; role: string | null }, projectId: string): Promise<boolean> {
  const state = await reader.read(companyId);
  const restricted = isRestricted(state, person);
  if (restricted === false) return true;
  if (restricted === "closed" || state.state !== "need_to_know") return false;
  return projectVisible(state.policy, person, projectId);
}
