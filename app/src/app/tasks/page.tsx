import { TasksDashboard } from "@/components/tasks/tasks-dashboard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Aria · Mission Control" };

export default function TasksPage() {
  return <TasksDashboard />;
}
