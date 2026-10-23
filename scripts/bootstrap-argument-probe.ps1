param([string]$Destination, [string]$Text, [string]$Second)
@{ text=$Text; second=$Second } | ConvertTo-Json | Set-Content -LiteralPath $Destination -Encoding UTF8
Write-Output 'Argument probe executed.'
