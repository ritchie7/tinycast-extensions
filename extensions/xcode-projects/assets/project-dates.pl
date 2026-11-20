use strict;
use warnings;
use File::Basename qw(dirname);
use POSIX qw(strftime);

# Inspect Xcode state off the UI thread, in the same pass as Spotlight.
my $user = getpwuid($<);
open(my $index, '-|', '/usr/bin/mdfind', @ARGV) or die "Cannot start Spotlight: $!";
binmode STDOUT;
local $/ = "\0";
while (my $record = <$index>) {
    chomp $record;
    my ($file, $date) = $record =~ /^(.*?)\s+kMDItemLastUsedDate\s*=\s*(.*?)\s*$/s;
    $file //= $record;
    $date //= '(null)';
    my $workspace;
    if ($file =~ /\.xcodeproj$/) { $workspace = "$file/project.xcworkspace"; }
    elsif ($file =~ /\.xcworkspace$/) { $workspace = $file; }
    elsif ($file =~ /\/Package\.swift$/) { $workspace = dirname($file).'/.swiftpm/xcode/package.xcworkspace'; }
    elsif ($file =~ /\.playground$/) { $workspace = "$file/playground.xcworkspace"; }
    my $state = defined($workspace) ? (stat("$workspace/xcuserdata/$user.xcuserdatad/UserInterfaceState.xcuserstate"))[9] : undef;
    print $file, " kMDItemLastUsedDate = ", $date, "\t", ($state // 0), "\0";
}
close($index) or exit(($? >> 8) || 1);
