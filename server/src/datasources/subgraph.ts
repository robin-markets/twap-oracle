import { DataSourceError, type SubgraphMarket } from "../types.js";

const MARKETS_QUERY = `
  query GetMarketsForTwap($conditionIds: [String!]!) {
    markets(where: { id_in: $conditionIds }) {
      id
      yesToken {
        id
        twapIndex
        startedAt
        lastUpdatedAt
        lastPrice
        resolvedAt
        resolvedPrice
      }
      noToken {
        id
        twapIndex
        startedAt
        lastUpdatedAt
        lastPrice
        resolvedAt
        resolvedPrice
      }
      robinInitializedAt
      twapSnapshotYes
      twapSnapshotNo
      robinTwapIndexYes
      robinLastUpdatedAt
      robinResolvedAt
      robinResolvedYesPrice
      robinResolvedNoPrice
    }
  }
`;

interface GraphQLResponse {
  data?: { markets: SubgraphMarket[] };
  errors?: Array<{ message: string }>;
}

export async function fetchMarkets(
  subgraphUrl: string,
  conditionIds: string[]
): Promise<SubgraphMarket[]> {
  let response: Response;
  try {
    response = await fetch(subgraphUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: MARKETS_QUERY,
        variables: { conditionIds },
      }),
    });
  } catch (err) {
    throw new DataSourceError(
      "Subgraph unreachable",
      err instanceof Error ? err.message : String(err)
    );
  }

  if (!response.ok) {
    throw new DataSourceError(
      `Subgraph HTTP ${response.status}`,
      await response.text()
    );
  }

  const json = (await response.json()) as GraphQLResponse;

  if (json.errors?.length) {
    throw new DataSourceError(
      "Subgraph query error",
      json.errors.map((e) => e.message).join("; ")
    );
  }

  if (!json.data) {
    throw new DataSourceError("Subgraph returned no data");
  }

  return json.data.markets;
}
