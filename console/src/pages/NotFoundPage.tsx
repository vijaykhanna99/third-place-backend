import { Link } from "react-router-dom";
import { EmptyState } from "../components/EmptyState";

export function NotFoundPage() {
  return (
    <EmptyState title="Page not found" action={<Link to="/">Back to the dashboard</Link>}>
      The address does not match anything in the console.
    </EmptyState>
  );
}
