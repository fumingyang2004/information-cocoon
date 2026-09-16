$ErrorActionPreference = 'Stop'
$bvid = 'BV1kAYS6FEeF'
$viewUrl = "https://api.bilibili.com/x/web-interface/view?bvid=$bvid"
$view = Invoke-RestMethod $viewUrl -TimeoutSec 20
if ($view.code -ne 0) { throw "Video API: $($view.message)" }
$replyUrl = "https://api.bilibili.com/x/v2/reply?type=1&oid=$($view.data.aid)&sort=1&pn=1&ps=20"
$reply = Invoke-RestMethod $replyUrl -TimeoutSec 20
if ($reply.code -ne 0) { throw "Reply API: $($reply.message)" }
$pin = $reply.data.upper.top
if (-not $pin) { throw 'Missing author pin' }
function Select-Comment($comment) {
  [ordered]@{
    rpid_str = $comment.rpid_str; root_str = $comment.root_str; parent_str = $comment.parent_str
    mid_str = $comment.mid_str
    member = @{ mid = $comment.member.mid; uname = $comment.member.uname }
    content = @{ message = $comment.content.message; max_line = $comment.content.max_line }
    reply_control = $comment.reply_control
    rcount = $comment.rcount
  }
}
$pinned = Select-Comment $pin
$pinned.replies = @($pin.replies | Where-Object { $_.mid_str -eq '285286947' } | ForEach-Object { Select-Comment $_ })
$result = [ordered]@{
  capturedAt = [DateTime]::UtcNow.ToString('o')
  evidence = 'Live public API data; not a live browser/Shadow DOM verification'
  urls = @($viewUrl, $replyUrl)
  bvid = $bvid; duration = $view.data.duration
  owner = @{ name = $view.data.owner.name; mid = $view.data.owner.mid }
  pinned = $pinned
}
$outFile = Join-Path $PSScriptRoot 'split-timeline-source.json'
[IO.File]::WriteAllText($outFile, ($result | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
[pscustomobject]$result | Select-Object bvid,duration,@{n='pin';e={$_.pinned.rpid_str}},@{n='replies';e={$_.pinned.replies.rpid_str}} | ConvertTo-Json
