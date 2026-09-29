import { OrgInboundTriggersList } from "@/components/org-inbound-triggers-list";

const OrgInboundTriggersPage = async ({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) => {
  const { orgId } = await params;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Inbound Triggers</h1>
      <p className="text-muted-foreground mb-6">
        Every trigger in this organization that a system outside Platypus can
        call. Workspace owners create them and manage their tokens. You can
        revoke a token to stop its calls straight away. Which workspaces accept
        calls at all is set under General.
      </p>
      <OrgInboundTriggersList orgId={orgId} />
    </div>
  );
};

export default OrgInboundTriggersPage;
