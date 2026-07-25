import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";

const ADO_SCOPE = "499b84ac-1321-427f-aa17-267ca6975798/.default";

export class EntraTokenProvider {
  public constructor(private readonly credential: TokenCredential = new DefaultAzureCredential()) {}

  public async getAzureDevOpsToken(): Promise<string> {
    const token = await this.credential.getToken(ADO_SCOPE);
    if (!token?.token) throw new Error("Microsoft Entra did not return an Azure DevOps token");
    return token.token;
  }
}
