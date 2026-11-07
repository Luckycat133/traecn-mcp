require "json"

class Traecnclaw < Formula
  desc "Local-first MCP server and Agent Skill for TraeCN desktop automation"
  homepage "https://github.com/Luckycat133/traecn-mcp"
  url "https://github.com/Luckycat133/traecn-mcp/releases/download/v0.7.0/traecnclaw-0.7.0.tgz"
  sha256 "30cce7dafc73f44dbdf8fed94f92a5fa1ace2ed548dcc47937a35fcf09fdac2a"
  license "MIT"

  depends_on "node"

  def install
    (libexec/"lib").install Dir["*"]
    node_bin = formula_opt_bin("node")
    cd libexec/"lib" do
      system node_bin/"node", node_bin/"npm", "install", "--omit=dev", "--ignore-scripts",
             "--no-audit", "--no-fund"
    end

    (bin/"traecn-mcp").write_env_script(
      libexec/"lib/mcp-server.js",
      PATH: "#{formula_opt_bin("node")}:/usr/bin:/bin:/usr/sbin:/sbin",
    )
    chmod 0755, bin/"traecn-mcp"
  end

  def caveats
    <<~EOS
      Start the local gateway beside TraeCN:

        traecn-mcp quickstart --launch-trae

      Keep the gateway terminal open. In another terminal, generate the host entry:

        traecn-mcp setup-mcp

      Add the generated traecn entry to your MCP host and reconnect.
      Run traecn-mcp doctor to diagnose setup issues.
    EOS
  end

  test do
    assert_match "setup-mcp", shell_output("#{bin}/traecn-mcp help")

    messages = [
      {
        jsonrpc: "2.0",
        id:      1,
        method:  "initialize",
        params:  {
          protocolVersion: "2025-11-25",
          capabilities:    {},
          clientInfo:      { name: "homebrew-test", version: "1" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]
    output = pipe_output(bin/"traecn-mcp", "#{messages.map(&:to_json).join("\n")}\n")
    tools = output.lines.map { |line| JSON.parse(line) }.find { |item| item["id"] == 2 }.dig("result", "tools")
    assert_equal 20, tools.length
    assert_equal "traecn_send_message", tools.first["name"]
    assert_equal "traecn_decide_approval", tools.last["name"]
  end
end
